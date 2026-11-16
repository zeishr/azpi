import type {
  AgentContext,
  ClientCapabilities,
  EnvVariable,
  TerminalOutputResponse,
} from "@agentclientprotocol/sdk";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  BashToolDetails,
  EditOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";

/**
 * Pi's own read, write, edit and bash tools, with their file and process
 * access routed through the ACP client.
 *
 * Going through the client lets it show unsaved buffers to the agent, track
 * and review the agent's edits, and run commands in terminals it displays.
 * Pi keeps its schemas, prompts, truncation, image handling and fuzzy edit
 * matching: only the operations underneath change.
 */

const POLL_INTERVAL_MS = 250;

/** Shell exit code for a process killed by a signal, the convention Pi's local shell follows. */
const SIGNAL_EXIT_BASE = 128;

export interface AcpProxyToolOptions {
  /** The ACP client context for outbound requests */
  client: AgentContext;
  /** Current session ID */
  sessionId: string;
  /** Client capabilities from initialize */
  capabilities: ClientCapabilities | undefined;
  /** Working directory for resolving relative paths */
  cwd: string;
}

/**
 * Creates the tools the client advertised capabilities for. Returns an empty
 * array when it advertised none, leaving Pi's local tools in place.
 */
export function createAcpProxyTools({
  client,
  sessionId,
  capabilities,
  cwd,
}: AcpProxyToolOptions): ToolDefinition[] {
  const files = new ClientFiles(client, sessionId);
  // Each built-in definition has its own parameter and details types.
  const tools: ToolDefinition<any, any, any>[] = [];

  if (capabilities?.fs?.readTextFile) {
    tools.push(createReadToolDefinition(cwd, { operations: files.readOperations() }));
  }
  if (capabilities?.fs?.writeTextFile) {
    tools.push(createWriteToolDefinition(cwd, { operations: files.writeOperations() }));
  }
  if (capabilities?.fs?.readTextFile && capabilities.fs.writeTextFile) {
    tools.push(createEditToolDefinition(cwd, { operations: files.editOperations() }));
  }
  if (capabilities?.terminal) {
    tools.push(createTerminalBashTool(client, sessionId, cwd));
  }

  return tools;
}

/**
 * File access through the client, falling back to the disk when the client
 * refuses a path: Zed only serves files of the open project, while Pi may
 * touch any file.
 */
class ClientFiles {
  constructor(
    private readonly client: AgentContext,
    private readonly sessionId: string,
  ) {}

  readOperations(): ReadOperations {
    return {
      // Images are binary: the client only serves text, so they come from the disk.
      readFile: async (path) =>
        (await detectSupportedImageMimeTypeFromFile(path)) ? readFile(path) : this.read(path),
      access: (path) => this.access(path, constants.R_OK),
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    };
  }

  writeOperations(): WriteOperations {
    return {
      writeFile: (path, content) => this.write(path, content),
      mkdir: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
    };
  }

  editOperations(): EditOperations {
    return {
      readFile: (path) => this.read(path),
      writeFile: (path, content) => this.write(path, content),
      access: (path) => this.access(path, constants.R_OK | constants.W_OK),
    };
  }

  private async read(path: string): Promise<Buffer> {
    try {
      const { content } = await this.client.request("fs/read_text_file", {
        sessionId: this.sessionId,
        path,
      });
      return Buffer.from(content, "utf8");
    } catch {
      // The disk error names the path and the cause, unlike the client's.
      return readFile(path);
    }
  }

  private async write(path: string, content: string): Promise<void> {
    try {
      await this.client.request("fs/write_text_file", { sessionId: this.sessionId, path, content });
    } catch {
      await writeFile(path, content, "utf8");
    }
  }

  /** Checked on disk: ACP has no access check, and these files exist there. */
  private async access(path: string, mode: number): Promise<void> {
    await access(path, mode);
  }
}

/**
 * Pi's bash tool running each command in a client terminal, embedded in the
 * tool call so the client streams it live.
 *
 * Operations are built per call because the embedding needs the tool call id.
 * Results carry the terminal id in their details, which tells the event
 * bridge to leave the embedded terminal in place of plain text output.
 */
function createTerminalBashTool(
  client: AgentContext,
  sessionId: string,
  cwd: string,
): ReturnType<typeof createBashToolDefinition> {
  const definition = createBashToolDefinition(cwd);
  const execute: typeof definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const terminal = new ClientTerminal(client, sessionId, toolCallId);
    const tool = createBashToolDefinition(cwd, { operations: terminal.operations() });
    const tag = (details: BashToolDetails | undefined): TerminalBashDetails | undefined =>
      terminal.id ? { ...details, terminalId: terminal.id } : details;

    const result = await tool.execute(
      toolCallId,
      params,
      signal,
      onUpdate && ((partial) => onUpdate({ ...partial, details: tag(partial.details) })),
      ctx,
    );
    return { ...result, details: tag(result.details) };
  };
  return { ...definition, execute };
}

/** Pi's bash details plus the terminal the command ran in, read by the event bridge. */
type TerminalBashDetails = BashToolDetails & { terminalId?: string };

/** One command run in a client terminal, following Pi's BashOperations contract. */
class ClientTerminal {
  id: string | undefined;

  constructor(
    private readonly client: AgentContext,
    private readonly sessionId: string,
    private readonly toolCallId: string,
  ) {}

  operations(): BashOperations {
    return { exec: (command, cwd, options) => this.exec(command, cwd, options) };
  }

  private async exec(
    command: string,
    cwd: string,
    { onData, signal, timeout, env }: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    if (signal?.aborted) throw new Error("aborted");

    const { terminalId } = await this.client.request("terminal/create", {
      sessionId: this.sessionId,
      command,
      cwd,
      env: piVariables(env),
    });
    this.id = terminalId;
    const terminal = { sessionId: this.sessionId, terminalId };

    try {
      // Embedded before anything else, as ACP only accepts it before terminal/release.
      await this.client.notify("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: this.toolCallId,
          content: [{ type: "terminal", terminalId }],
        },
      });
      return await this.follow(terminal, onData, signal, timeout);
    } finally {
      await this.client.request("terminal/release", terminal).catch(() => {
        // The terminal may already be gone with the connection; nothing to free then.
      });
    }
  }

  /**
   * Polls the terminal until it exits, forwarding new output. Abort and
   * timeout errors use the messages Pi's bash tool expects from its backends.
   */
  private async follow(
    terminal: { sessionId: string; terminalId: string },
    onData: (data: Buffer) => void,
    signal: AbortSignal | undefined,
    timeoutSeconds: number | undefined,
  ): Promise<{ exitCode: number | null }> {
    const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
    const forward = outputForwarder(onData);

    /* eslint-disable no-await-in-loop -- polling is sequential by nature */
    while (true) {
      const output: TerminalOutputResponse = await this.client.request("terminal/output", terminal);
      forward(output.output);

      if (output.exitStatus) return { exitCode: exitCodeOf(output.exitStatus) };
      if (signal?.aborted) {
        await this.client.request("terminal/kill", terminal);
        throw new Error("aborted");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        await this.client.request("terminal/kill", terminal);
        const last: TerminalOutputResponse = await this.client.request("terminal/output", terminal);
        forward(last.output);
        throw new Error(`timeout:${timeoutSeconds}`);
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
    /* eslint-enable no-await-in-loop */
  }
}

/**
 * Turns successive snapshots of a terminal's output into the chunks Pi's
 * accumulator expects. When the client truncated the start of the output, the
 * snapshot no longer extends the previous one: only what follows is lost.
 */
export function outputForwarder(onData: (data: Buffer) => void): (snapshot: string) => void {
  let seen = "";
  return (snapshot) => {
    if (snapshot.startsWith(seen)) {
      const added = snapshot.slice(seen.length);
      if (added) onData(Buffer.from(added, "utf8"));
    }
    seen = snapshot;
  };
}

export function exitCodeOf(status: {
  exitCode?: number | null;
  signal?: string | null;
}): number | null {
  if (typeof status.exitCode === "number") return status.exitCode;
  const signalNumber = status.signal
    ? osConstants.signals[status.signal as keyof typeof osConstants.signals]
    : undefined;
  return signalNumber === undefined ? null : SIGNAL_EXIT_BASE + signalNumber;
}

/**
 * Pi passes its whole shell environment, but the client terminal has its own.
 * Only the PI_* variables, which describe the session to the command, are
 * worth sending.
 */
export function piVariables(env: NodeJS.ProcessEnv | undefined): EnvVariable[] {
  return Object.entries(env ?? {})
    .filter(
      (entry): entry is [string, string] => entry[0].startsWith("PI_") && entry[1] !== undefined,
    )
    .map(([name, value]) => ({ name, value }));
}

/** Sleep for ms, waking early if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
