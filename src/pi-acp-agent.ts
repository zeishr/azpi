import { PROTOCOL_VERSION, RequestError, agent } from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  AgentContext,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  CloseSessionRequest,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAcpProxyTools } from "./client-tool-proxy";
import { SessionEventBridge, buildUsageUpdate, mapStopReason } from "./event-bridge";
import {
  convertPromptContent,
  deriveSessionName,
  extractTextContent,
  generateSessionName,
} from "./prompt-content";
import {
  buildModelConfigOption,
  buildModeState,
  buildThinkingLevelConfigOption,
  resolveModelById,
} from "./model";
import { SessionUpdateType } from "./session-update-types";
import { buildStartupMessage } from "./startup-message";
import { version as AGENT_VERSION } from "../package.json";
import {
  findBuiltinCommand,
  parseSlashCommand,
  discoverCommands,
  findExtensionCommand,
  isExtensionCommandAllowed,
  parseExtensionWhitelist,
} from "./slash-commands";
import { SessionResolver, replaySessionHistory } from "./session";
import { createAcpUiBridge } from "./extension-ui-bridge";

export interface PiAcpAgentOptions {
  /** Optional createAgentSession overrides (model, tools, etc.) */
  sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "sessionManager">;
  /** Model runtime for auth and model management (required) */
  modelRuntime: ModelRuntime;
  /** Optional model registry (defaults to wrapping modelRuntime) */
  modelRegistry?: ModelRegistry;
  /** Optional session factory for testing */
  sessionFactory?: (cwd: string) => Promise<{ session: AgentSession }>;
  /** Resolves to a warning shown in the startup message, e.g. a Pi version drift */
  startupWarning?: Promise<string | undefined>;
  /** Called with each initialize request, before answering it */
  onInitialize?: (request: InitializeRequest) => void;
}

/**
 * Core class handling ACP agent requests, managing Pi session lifecycle
 * and bridging Pi events to ACP notifications.
 */
export class PiAcpAgent {
  private sessions = new Map<string, AgentSession>();
  private bridges = new Map<string, SessionEventBridge>();
  /** Last message of the latest Pi run, which decides the stop reason once it settles. */
  private lastRunMessages = new Map<string, AgentMessage | undefined>();
  private unsubscribers = new Map<string, () => void>();
  private pendingPrompts = new Map<string, { resolve: (r: PromptResponse) => void }>();
  private abortControllers = new Map<string, AbortController>();
  private sessionResolver = new SessionResolver();
  private commandsAdvertised = new Set<string>();
  private startupMessageSent = new Set<string>();
  private notificationDrainGate: Promise<unknown> = Promise.resolve();

  readonly options: PiAcpAgentOptions;
  readonly client: AgentContext;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly extensionWhitelist: Set<string> | null;
  private clientCapabilities?: ClientCapabilities;

  readonly availableModels: Model<any>[];

  constructor(client: AgentContext, options: PiAcpAgentOptions) {
    this.client = client;
    this.options = options;
    this.modelRuntime = options.modelRuntime;
    this.modelRegistry = options.modelRegistry ?? new ModelRegistry(this.modelRuntime);
    this.availableModels = this.modelRegistry.getAvailable();
    this.extensionWhitelist = parseExtensionWhitelist();
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.options.onInitialize?.(request);
    this.clientCapabilities = request.clientCapabilities;

    const anyModelSupportsImage = this.availableModels.some((m) => m.input.includes("image"));

    const response: InitializeResponse = {
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          audio: false,
          image: anyModelSupportsImage,
          embeddedContext: true,
        },
        sessionCapabilities: {
          close: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: "AZPi",
        version: AGENT_VERSION,
      },
      protocolVersion: PROTOCOL_VERSION,
    };

    return response;
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // Not support interactive auth, use API Keys instead
  }

  async newSession({ cwd }: NewSessionRequest): Promise<NewSessionResponse> {
    const { session, sessionId } = await this.createAndRegisterSession({
      cwd: cwd ?? process.cwd(),
    });

    if (!session.model && this.availableModels.length > 0) {
      await session.setModel(this.availableModels[0]!);
    }

    // Defer notifications until after response is flushed.
    // ZED only registers the session after processing NewSessionResponse,
    // so session/update notifications sent before the response are silently dropped.
    setImmediate(() => {
      this.safeNotify(() => this.discoverAndEmitCommands(sessionId));
      this.sendStartupMessage(sessionId, session);
      this.sendUsageUpdate(sessionId, session);
    });

    return {
      sessionId,
      modes: session.model ? buildModeState(this.availableModels, session.model) : undefined,
      configOptions: this.buildConfigOptions(session),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const cwd = params.cwd ?? process.cwd();
    const { sessionId } = params;

    const sessionPath = await this.sessionResolver.resolveSessionPath(cwd, sessionId);

    const { session } = await this.createAndRegisterSession({ cwd, sessionId, sessionPath });

    if (sessionPath) {
      await replaySessionHistory(session, sessionId, this.client);
    }
    this.sendUsageUpdate(sessionId, session);

    this.startupMessageSent.add(sessionId);
    this.safeNotify(() => this.discoverAndEmitCommands(sessionId));

    return {
      modes: session.model ? buildModeState(this.availableModels, session.model) : undefined,
      configOptions: this.buildConfigOptions(session),
    };
  }

  async resumeSession({ sessionId }: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const cwd = process.cwd();
    const sessionPath = await this.sessionResolver.resolveSessionPath(cwd, sessionId);

    const { session } = await this.createAndRegisterSession({ cwd, sessionId, sessionPath });

    this.startupMessageSent.add(sessionId);

    if (sessionPath) {
      await replaySessionHistory(session, sessionId, this.client);
    }
    this.sendUsageUpdate(sessionId, session);

    return {};
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd ?? process.cwd();

    await this.sessionResolver.warmCache(cwd);

    const sessions: SessionInfo[] = (await SessionManager.list(cwd)).map((info) => ({
      sessionId: info.id,
      cwd: info.cwd,
      title: info.name || undefined,
      updatedAt: info.modified.toISOString(),
      _meta: {
        messageCount: info.messageCount,
      },
    }));

    return { sessions };
  }

  async setSessionMode({
    sessionId,
    modeId,
  }: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.getSessionOrThrow(sessionId);
    const model = resolveModelById(this.modelRegistry, modeId);

    try {
      await session.setModel(model);
      await this.sendConfigOptionsUpdate(sessionId);
      this.sendUsageUpdate(sessionId, session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.notifyError(sessionId, message);
      throw error;
    }

    return {};
  }

  async setSessionConfigOption({
    sessionId,
    configId,
    value,
  }: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.getSessionOrThrow(sessionId);

    try {
      if (configId === "model") {
        const model = resolveModelById(this.modelRegistry, value as string);
        await session.setModel(model);
        // The context window comes with the model.
        this.sendUsageUpdate(sessionId, session);
      } else if (configId === "thinking-level") {
        session.setThinkingLevel(value as AgentSession["thinkingLevel"]);
      } else {
        throw RequestError.invalidParams(`Unknown config option: ${configId}`);
      }

      return {
        configOptions: this.buildConfigOptions(session),
      };
    } catch (error: unknown) {
      if (error instanceof RequestError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.notifyError(sessionId, message);
      throw error;
    }
  }

  async prompt({ sessionId, prompt }: PromptRequest): Promise<PromptResponse> {
    const session = this.getSessionOrThrow(sessionId);

    // Fallback: re-send commands + startup message if the deferred send
    // raced with a prompt and ZED hasn't received them yet.
    if (!this.commandsAdvertised.has(sessionId)) {
      this.safeNotify(() => this.discoverAndEmitCommands(sessionId));
    }
    if (!this.startupMessageSent.has(sessionId)) {
      this.sendStartupMessage(sessionId, session);
    }

    const { text, images } = convertPromptContent(prompt, session.model);

    const matchCommand = parseSlashCommand(text);
    if (matchCommand) {
      const builtin = findBuiltinCommand(matchCommand.name);
      if (builtin) {
        try {
          const result = await builtin.execute(session, matchCommand.args);

          if (matchCommand.name === "reload") {
            this.safeNotify(() => this.discoverAndEmitCommands(sessionId));
          }

          await this.client.notify("session/update", {
            sessionId,
            update: {
              content: { text: result, type: "text" },
              sessionUpdate: SessionUpdateType.AgentMessageChunk,
            },
          });

          return { stopReason: "end_turn" };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.notifyError(sessionId, message);
          return { stopReason: "end_turn" };
        }
      }

      const extensionCmd = findExtensionCommand(session, matchCommand.name);
      if (extensionCmd) {
        if (!isExtensionCommandAllowed(matchCommand.name, this.extensionWhitelist)) {
          await this.client.notify("session/update", {
            sessionId,
            update: {
              content: {
                text:
                  `Command "/${matchCommand.name}" is not allowed. ` +
                  `Set AZPI_ALLOW_EXTENSION_COMMANDS to whitelist it.`,
                type: "text",
              },
              sessionUpdate: SessionUpdateType.AgentMessageChunk,
            },
          });

          return { stopReason: "end_turn" };
        }

        // Extension commands bypass the agent loop (no agent_start/agent_end).
        // Pass to Pi which routes to the handler. Output flows via
        // the notify() bridge (agent_message_chunk) and/or pi.sendMessage().
        try {
          await session.prompt(text, images.length > 0 ? { images } : undefined);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.notifyError(sessionId, message);
        }

        return { stopReason: "end_turn" };
      }
    }

    if (!session.sessionName) {
      this.startSessionNaming(session, prompt);
    }

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    const promptPromise = new Promise<PromptResponse>((resolve) => {
      this.pendingPrompts.set(sessionId, { resolve });
    });

    session.prompt(text, images.length > 0 ? { images } : undefined).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.notifyError(sessionId, message);
      const existing = this.pendingPrompts.get(sessionId);
      if (existing) {
        existing.resolve({ stopReason: "end_turn" });
      }
    });

    const result = await promptPromise;
    this.abortControllers.delete(sessionId);
    return result;
  }

  async cancel({ sessionId }: CancelNotification): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      // session.abort() waits for agent idle (finishRun) before returning,
      // so isStreaming is false by the time we resolve.
      await session.abort();
      this.pendingPrompts.delete(sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  async closeSession({ sessionId }: CloseSessionRequest): Promise<void> {
    await this.cleanupSession(sessionId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }

  private sendStartupMessage(sessionId: string, session: AgentSession): void {
    this.startupMessageSent.add(sessionId);
    this.safeNotify(async () => {
      const warning = await this.options.startupWarning;
      await this.client.notify("session/update", {
        sessionId,
        update: {
          content: { text: buildStartupMessage(session, warning), type: "text" },
          sessionUpdate: SessionUpdateType.AgentMessageChunk,
        },
      });
    });
  }

  private buildConfigOptions(session: AgentSession): SessionConfigOption[] {
    return [
      buildModelConfigOption(session, this.availableModels),
      buildThinkingLevelConfigOption(session),
    ];
  }

  private async sendConfigOptionsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: SessionUpdateType.ConfigOptionUpdate,
        configOptions: this.buildConfigOptions(session),
      },
    };

    await this.client.notify("session/update", notification);
  }

  /**
   * Fire-and-forget session naming. Sets the session name asynchronously
   * without blocking the main prompt flow.
   *
   * If AZPI_SESSION_NAMING_MODEL env var is set to "provider/modelId",
   * calls that model to generate a concise name from the first prompt.
   * Falls back to deriveSessionName (text heuristic) on any failure.
   */
  private startSessionNaming(session: AgentSession, prompt: ContentBlock[]): void {
    const namingModelId = process.env.AZPI_SESSION_NAMING_MODEL?.trim();

    (async () => {
      try {
        let name: string | undefined;

        if (namingModelId) {
          try {
            const namingModel = resolveModelById(this.modelRegistry, namingModelId);
            const authResult = await this.modelRuntime.getAuth(namingModel);
            const promptText = extractTextContent(prompt);
            if (promptText && authResult) {
              const headers = authResult.auth.headers
                ? Object.fromEntries(
                    Object.entries(authResult.auth.headers).filter(
                      (v): v is [string, string] => v[1] != null,
                    ),
                  )
                : undefined;
              name = await generateSessionName(
                namingModel,
                promptText,
                authResult.auth.apiKey,
                headers,
              );
            }
          } catch {
            // Fall through to deriveSessionName
          }
        }

        if (!name) {
          name = deriveSessionName(prompt);
        }

        if (name) {
          session.setSessionName(name);
        }
      } catch {
        // Best-effort naming — silently ignore failures
      }
    })();
  }

  private async createAndRegisterSession({
    cwd,
    sessionId,
    sessionPath,
  }: {
    cwd: string;
    sessionId?: string;
    sessionPath?: string;
  }): Promise<{ session: AgentSession; sessionId: string }> {
    if (this.options.sessionFactory) {
      const result = await this.options.sessionFactory(cwd);
      const session = result.session;
      const resolvedSessionId = session.sessionId;
      this.registerSession(resolvedSessionId, session, cwd);
      return { session, sessionId: resolvedSessionId };
    }

    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath)
      : SessionManager.create(cwd);

    const resolvedSessionId = sessionId ?? sessionManager.getSessionId();

    const { session } = await createAgentSession({
      cwd,
      sessionManager,
      customTools: createAcpProxyTools({
        client: this.client,
        sessionId: resolvedSessionId,
        capabilities: this.clientCapabilities,
        cwd,
      }),
      modelRuntime: this.modelRuntime,
      ...this.options.sessionOptions,
    });

    await session.bindExtensions({
      uiContext: createAcpUiBridge(this.client, resolvedSessionId),
    });

    this.registerSession(resolvedSessionId, session, cwd);

    return { session, sessionId: resolvedSessionId };
  }

  private registerSession(sessionId: string, session: AgentSession, cwd: string): void {
    this.sessions.set(sessionId, session);
    this.bridges.set(
      sessionId,
      new SessionEventBridge({ sessionId, cwd, capabilities: this.clientCapabilities }),
    );
    if (session.sessionFile) {
      this.sessionResolver.registerSession(sessionId, session.sessionFile);
    }
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.onEvent(sessionId, event);
    });
    this.unsubscribers.set(sessionId, unsubscribe);
  }

  private async cleanupSession(sessionId: string): Promise<void> {
    const unsubscribe = this.unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.unsubscribers.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await session.abort();
      } catch {
        // Ignore errors during cleanup
      }
      session.dispose();
      this.sessions.delete(sessionId);
    }

    this.sessionResolver.unregisterSession(sessionId);
    this.bridges.delete(sessionId);
    this.lastRunMessages.delete(sessionId);
    this.commandsAdvertised.delete(sessionId);
    this.startupMessageSent.delete(sessionId);

    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      // session.abort() above already waited for agent idle (finishRun).
      this.pendingPrompts.delete(sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }

    this.abortControllers.delete(sessionId);
  }

  private getSessionOrThrow(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private onEvent(sessionId: string, event: AgentSessionEvent): void {
    const session = this.sessions.get(sessionId);
    // Config options only matter to thinking level changes; building them is not free.
    const configOptions =
      session && event.type === "thinking_level_changed"
        ? this.buildConfigOptions(session)
        : undefined;
    for (const notification of this.bridges.get(sessionId)?.map(event, configOptions) ?? []) {
      this.safeNotify(() => this.client.notify("session/update", notification));
    }

    if (event.type === "turn_end" && session) {
      this.sendUsageUpdate(sessionId, session);
    } else if (event.type === "agent_end") {
      this.lastRunMessages.set(sessionId, event.messages[event.messages.length - 1]);
    } else if (event.type === "agent_settled") {
      // agent_end may still be followed by a retry, a compaction retry or
      // queued messages; agent_settled is the point where Pi stops on its own.
      const stopReason = event.aborted
        ? "cancelled"
        : mapStopReason(this.lastRunMessages.get(sessionId));
      this.settlePrompt(sessionId, session, stopReason);
    }
  }

  /**
   * Zed draws its context ring from these updates and shows none until the
   * first one arrives, so they go out when a session opens, after each turn,
   * and when the model, and with it the context window, changes.
   */
  private sendUsageUpdate(sessionId: string, session: AgentSession): void {
    const update = buildUsageUpdate(session.getContextUsage(), session.getSessionStats().cost);
    if (update) {
      this.safeNotify(() => this.client.notify("session/update", { sessionId, update }));
    }
  }

  private settlePrompt(
    sessionId: string,
    session: AgentSession | undefined,
    stopReason: PromptResponse["stopReason"],
  ): void {
    // Drain all in-flight session/update notifications BEFORE resolving
    // the prompt RPC response. The ACP spec requires that all notifications
    // for a turn be sent before the terminal session/prompt response.
    // Without this drain, agent_message_chunk frames race past end_turn
    // while the final text is still streaming.
    this.notificationDrainGate
      .then(() =>
        this.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: SessionUpdateType.SessionInfoUpdate,
            updatedAt: new Date().toISOString(),
          },
        }),
      )
      .catch(() => {
        // Connection may be closing; ignore
      })
      .finally(async () => {
        // Wait for finishRun() to set isStreaming = false before resolving
        // the prompt promise. Without this, the client can send a new prompt
        // while the agent is still marked as streaming.
        if (session) {
          await session.agent.waitForIdle();
        }
        const pending = this.pendingPrompts.get(sessionId);
        if (pending) {
          this.pendingPrompts.delete(sessionId);
          pending.resolve({ stopReason });
        }
      });
  }

  private async discoverAndEmitCommands(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: SessionUpdateType.AvailableCommandsUpdate,
        availableCommands: discoverCommands(session, this.extensionWhitelist),
      },
    };

    await this.client.notify("session/update", notification);
    this.commandsAdvertised.add(sessionId);
  }

  private notifyError(sessionId: string, message: string): void {
    this.safeNotify(() =>
      this.client.notify("session/update", {
        sessionId,
        update: {
          content: { text: `❌ Error: ${message}`, type: "text" },
          sessionUpdate: SessionUpdateType.AgentMessageChunk,
        },
      }),
    );
  }

  private safeNotify(fn: () => Promise<void>): void {
    const promise = fn().catch(() => {
      // Connection may be closing; ignore
    });
    // Chain into drain gate so agent_end can await all pending writes
    this.notificationDrainGate = Promise.allSettled([this.notificationDrainGate, promise]);
  }
}

/**
 * Builds the ACP agent app, routing each ACP method to a PiAcpAgent
 * created per connection and disposed when the connection closes.
 */
export function createAgentApp(options: PiAcpAgentOptions): AgentApp {
  // onConnect runs synchronously inside connect(), before any message is handled.
  let pi: PiAcpAgent;
  return agent({ name: "AZPi" })
    .onConnect((connection) => {
      pi = new PiAcpAgent(connection.client, options);
      void connection.closed.then(() => pi.close());
    })
    .onRequest("initialize", (ctx) => pi.initialize(ctx.params))
    .onRequest("authenticate", (ctx) => pi.authenticate(ctx.params))
    .onRequest("session/new", (ctx) => pi.newSession(ctx.params))
    .onRequest("session/load", (ctx) => pi.loadSession(ctx.params))
    .onRequest("session/resume", (ctx) => pi.resumeSession(ctx.params))
    .onRequest("session/list", (ctx) => pi.listSessions(ctx.params))
    .onRequest("session/close", (ctx) => pi.closeSession(ctx.params))
    .onRequest("session/set_mode", (ctx) => pi.setSessionMode(ctx.params))
    .onRequest("session/set_config_option", (ctx) => pi.setSessionConfigOption(ctx.params))
    .onRequest("session/prompt", (ctx) => pi.prompt(ctx.params))
    .onNotification("session/cancel", (ctx) => pi.cancel(ctx.params));
}
