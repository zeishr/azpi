import type {
  ClientCapabilities,
  ContentBlock,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentSessionEvent, ContextUsage } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ToolCallMapper } from "./tool-call-mapper";
import { SessionUpdateType } from "./session-update-types";

export interface SessionEventBridgeOptions {
  sessionId: string;
  /** Session working directory, used to resolve the paths tools receive. */
  cwd: string;
  capabilities?: ClientCapabilities;
}

/**
 * Maps the Pi events of one session to ACP session/update notifications.
 *
 * Stateful because some updates span several events: a tool result needs the
 * arguments seen when the tool started, and a compaction's end must reuse the
 * id announced at its start.
 */
export class SessionEventBridge {
  private readonly tools: ToolCallMapper;
  private readonly sendsNotices: boolean;
  private readonly sendsCompactions: boolean;
  private compactionCount = 0;
  private currentCompactionId: string | undefined;

  constructor(private readonly options: SessionEventBridgeOptions) {
    this.tools = new ToolCallMapper({ cwd: options.cwd, live: true });
    // Both updates are opt-in: ACP forbids sending them to a client that did not ask.
    this.sendsNotices = Boolean(options.capabilities?.session?.notices);
    this.sendsCompactions = Boolean(options.capabilities?.session?.compaction);
  }

  /** Most events map to one notification or none; a subagent call may update several cards. */
  map(event: AgentSessionEvent, configOptions?: SessionConfigOption[]): SessionNotification[] {
    const { sessionId } = this.options;
    return this.mapUpdates(event, configOptions).map((update) => ({ sessionId, update }));
  }

  private mapUpdates(
    event: AgentSessionEvent,
    configOptions?: SessionConfigOption[],
  ): SessionUpdate[] {
    switch (event.type) {
      case "tool_execution_start":
        return this.tools.start(event.toolCallId, event.toolName, event.args, "in_progress");

      case "tool_execution_update":
        return this.tools.progress(
          event.toolCallId,
          event.toolName,
          event.args,
          event.partialResult,
        );

      case "tool_execution_end":
        return this.tools.end(event.toolCallId, event.toolName, event.result, event.isError);

      default: {
        const update = this.mapUpdate(event, configOptions);
        return update ? [update] : [];
      }
    }
  }

  private mapUpdate(
    event: AgentSessionEvent,
    configOptions?: SessionConfigOption[],
  ): SessionUpdate | null {
    switch (event.type) {
      case "message_update":
        return mapAssistantDelta(event.assistantMessageEvent);

      case "session_info_changed":
        return { sessionUpdate: SessionUpdateType.SessionInfoUpdate, title: event.name ?? null };

      case "thinking_level_changed":
        return configOptions
          ? { sessionUpdate: SessionUpdateType.ConfigOptionUpdate, configOptions }
          : null;

      case "compaction_start":
        return this.compactionStarted();

      case "compaction_end":
        return this.compactionEnded(event);

      case "auto_retry_start":
        return this.notice(
          "warning",
          `Retrying after an error (attempt ${event.attempt} of ${event.maxAttempts})`,
          event.errorMessage,
        );

      case "auto_retry_end":
        return event.success
          ? null
          : this.notice("error", `Gave up after ${event.attempt} attempts`, event.finalError);

      default:
        return null;
    }
  }

  private compactionStarted(): SessionUpdate | null {
    if (!this.sendsCompactions) return null;
    this.compactionCount += 1;
    this.currentCompactionId = `compaction-${this.compactionCount}`;
    return {
      sessionUpdate: SessionUpdateType.CompactionUpdate,
      compactionId: this.currentCompactionId,
      status: "in_progress",
    };
  }

  private compactionEnded(
    event: AgentSessionEvent & { type: "compaction_end" },
  ): SessionUpdate | null {
    const compactionId = this.currentCompactionId;
    this.currentCompactionId = undefined;
    if (!this.sendsCompactions || !compactionId) return null;

    if (event.aborted) {
      return {
        sessionUpdate: SessionUpdateType.CompactionUpdate,
        compactionId,
        status: "cancelled",
      };
    }
    if (!event.result) {
      return {
        sessionUpdate: SessionUpdateType.CompactionUpdate,
        compactionId,
        status: "failed",
        error: event.errorMessage ?? "Compaction produced no result",
      };
    }
    return {
      sessionUpdate: SessionUpdateType.CompactionUpdate,
      compactionId,
      status: "completed",
      summary: [{ type: "text", text: event.result.summary }],
    };
  }

  private notice(
    severity: "warning" | "error",
    title: string,
    description: string | undefined,
  ): SessionUpdate | null {
    if (!this.sendsNotices) return null;
    return {
      sessionUpdate: SessionUpdateType.Notice,
      severity,
      title,
      ...(description ? { description } : {}),
    };
  }
}

function mapAssistantDelta(
  assistantEvent: (AgentSessionEvent & { type: "message_update" })["assistantMessageEvent"],
): SessionUpdate | null {
  if (assistantEvent?.type !== "text_delta" && assistantEvent?.type !== "thinking_delta") {
    return null;
  }
  const delta = assistantEvent.delta;
  if (typeof delta !== "string" || delta.length === 0) return null;
  return {
    content: { text: delta, type: "text" },
    sessionUpdate:
      assistantEvent.type === "text_delta"
        ? SessionUpdateType.AgentMessageChunk
        : SessionUpdateType.AgentThoughtChunk,
  };
}

/**
 * Builds the context window and cost update, or null while Pi does not know
 * how full the context is (right after a compaction, before the next reply).
 */
export function buildUsageUpdate(
  usage: ContextUsage | undefined,
  totalCost: number,
): SessionUpdate | null {
  if (!usage || usage.tokens === null) return null;
  return {
    sessionUpdate: SessionUpdateType.UsageUpdate,
    used: Math.max(0, Math.round(usage.tokens)),
    size: usage.contextWindow,
    cost: { amount: totalCost, currency: "USD" },
  };
}

/**
 * Extracts text content from a Pi AgentMessage, joining all text parts.
 */
export function extractMessageText(message: AgentMessage | undefined): string | null {
  if (!message || !("content" in message)) return null;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .filter((block: any) => block.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text);
    if (parts.length > 0) {
      return parts.join("");
    }
  }
  return null;
}

/**
 * Maps the last message of a Pi run to an ACP StopReason.
 */
export function mapStopReason(message: AgentMessage | undefined): StopReason {
  if (!message || message.role !== "assistant") {
    return "end_turn";
  }
  switch (message.stopReason) {
    case "length":
      return "max_tokens";
    case "aborted":
      return "cancelled";
    case "stop":
    case "toolUse":
    case "error":
    default:
      return "end_turn";
  }
}

/**
 * Maps the final message content from an agent_end event to ACP content blocks.
 */
export function mapFinalContent(message: AgentMessage | undefined): ContentBlock[] {
  const text = extractMessageText(message);
  if (!text) {
    return [];
  }
  return [{ text, type: "text" }];
}
