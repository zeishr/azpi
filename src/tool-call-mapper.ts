import type { SessionUpdate, ToolCallStatus } from "@agentclientprotocol/sdk";
import { SessionUpdateType } from "./session-update-types";
import { SubagentCalls } from "./subagent-calls";
import { HIDDEN_NESTED_TOOLS, SUBAGENT_TOOL } from "./subagent-cards";
import {
  presentResultLocations,
  presentToolCall,
  presentToolProgress,
  presentToolResult,
} from "./tool-presentation";
import type { PresentationContext, ToolOutcome } from "./tool-presentation";
import { TerminalMirror, exitStatusOf } from "./terminal-mirror";

/** The tool whose output a client may show in a display terminal. */
const SHELL_TOOL = "bash";

/**
 * Builds the ACP tool call notifications of one session.
 *
 * Pi reports a tool's name and arguments when it starts but not with its
 * result, while the result card needs both (an edit's diff comes from its
 * arguments), so the mapper keeps them until the call ends.
 *
 * A `subagent` call's cards follow its children, through SubagentCalls.
 *
 * A bash call, for a client that displays terminals the agent feeds, shows a
 * terminal fed with its output instead of text. Its content is then never
 * resent: ACP replaces the whole content list on update, which would drop
 * the terminal.
 */
export class ToolCallMapper {
  private readonly calls = new Map<string, { name: string; args: unknown }>();
  /**
   * Last progress content sent per call. Tools report progress far more often
   * than what a card shows changes.
   */
  private readonly lastProgress = new Map<string, string>();
  /** Display terminals of the bash calls still running, by tool call id. */
  private readonly terminals = new Map<string, TerminalMirror>();
  private readonly subagents: SubagentCalls;

  constructor(private readonly context: PresentationContext) {
    this.subagents = new SubagentCalls(context);
  }

  /** Whether a subagent call is running, whose children's transcripts may grow. */
  get subagentsRunning(): boolean {
    return this.subagents.running;
  }

  /** Updates for the subagent cards whose children's transcripts grew since the last look. */
  pollSubagents(): SessionUpdate[] {
    return this.subagents.poll();
  }

  start(toolCallId: string, name: string, args: unknown, status: ToolCallStatus): SessionUpdate[] {
    this.calls.set(toolCallId, { name, args });
    if (HIDDEN_NESTED_TOOLS.has(name)) return [];
    if (name === SUBAGENT_TOOL) this.subagents.start(toolCallId, args);
    const view = presentToolCall(name, args, this.context);
    const call = {
      sessionUpdate: SessionUpdateType.ToolCall,
      toolCallId,
      title: view.title,
      kind: view.kind,
      status,
      locations: view.locations,
      content: view.content,
      rawInput: args,
    } as const;
    if (!this.showsTerminal(name)) return [call];

    // The call id doubles as the terminal id: unique per session and stable to its end.
    this.terminals.set(toolCallId, new TerminalMirror(toolCallId));
    return [
      {
        ...call,
        content: [{ type: "terminal", terminalId: toolCallId }],
        _meta: { terminal_info: { terminal_id: toolCallId, cwd: this.context.cwd } },
      },
    ];
  }

  progress(
    toolCallId: string,
    name: string,
    args: unknown,
    partialResult: unknown,
  ): SessionUpdate[] {
    if (HIDDEN_NESTED_TOOLS.has(name)) return [];
    const partial = toOutcome(partialResult, false);
    const terminal = this.terminals.get(toolCallId);
    if (terminal) return terminalOutput(toolCallId, terminal.progress(partial));
    if (name === SUBAGENT_TOOL) return this.subagents.progress(toolCallId, partial.details);

    const content = presentToolProgress(name, args, partial, this.context);
    const serialized = JSON.stringify(content);
    if (content === undefined || serialized === this.lastProgress.get(toolCallId)) return [];
    this.lastProgress.set(toolCallId, serialized);
    return [
      {
        sessionUpdate: SessionUpdateType.ToolCallUpdate,
        toolCallId,
        status: "in_progress",
        content,
      },
    ];
  }

  end(
    toolCallId: string,
    fallbackName: string,
    result: unknown,
    isError: boolean,
  ): SessionUpdate[] {
    const call = this.calls.get(toolCallId) ?? { name: fallbackName, args: undefined };
    this.calls.delete(toolCallId);
    this.lastProgress.delete(toolCallId);
    if (HIDDEN_NESTED_TOOLS.has(call.name)) return [];
    const outcome = toOutcome(result, isError);
    const status = isError ? "failed" : "completed";

    const terminal = this.terminals.get(toolCallId);
    if (terminal) {
      this.terminals.delete(toolCallId);
      return [terminalEnd(toolCallId, terminal, outcome, status)];
    }

    const { updates, ownContent } =
      call.name === SUBAGENT_TOOL
        ? this.subagents.end(toolCallId, call.args, outcome)
        : { updates: [], ownContent: [] };
    const resultContent = presentToolResult(call.name, call.args, outcome, this.context);
    const content =
      ownContent.length > 0 ? [...ownContent, ...(resultContent ?? [])] : resultContent;
    const locations = presentResultLocations(call.name, call.args, outcome, this.context);
    updates.push({
      sessionUpdate: SessionUpdateType.ToolCallUpdate,
      toolCallId,
      status,
      ...(content === undefined ? {} : { content }),
      ...(locations === undefined ? {} : { locations }),
    });
    return updates;
  }

  private showsTerminal(name: string): boolean {
    return name === SHELL_TOOL && this.context.live && this.context.terminalDisplay === true;
  }
}

/** Appends output to a call's display terminal, when there is any. */
function terminalOutput(toolCallId: string, data: string | undefined): SessionUpdate[] {
  if (!data) return [];
  return [
    {
      sessionUpdate: SessionUpdateType.ToolCallUpdate,
      toolCallId,
      _meta: { terminal_output: { terminal_id: toolCallId, data } },
    },
  ];
}

/** Ends a call's display terminal: the rest of its output, then its exit status. */
function terminalEnd(
  toolCallId: string,
  terminal: TerminalMirror,
  outcome: ToolOutcome,
  status: "completed" | "failed",
): SessionUpdate {
  const output = terminal.finish(outcome);
  return {
    sessionUpdate: SessionUpdateType.ToolCallUpdate,
    toolCallId,
    status,
    _meta: {
      ...(output ? { terminal_output: { terminal_id: toolCallId, data: output } } : {}),
      terminal_exit: { terminal_id: toolCallId, ...exitStatusOf(outcome) },
    },
  };
}

/**
 * Normalizes what Pi hands over as a result: an AgentToolResult or a stored
 * ToolResultMessage (both `{ content, details }`), or a bare value.
 */
function toOutcome(result: unknown, isError: boolean): ToolOutcome {
  if (result && typeof result === "object" && ("content" in result || "details" in result)) {
    const { content, details, structuredContent } = result as {
      content: unknown;
      details?: unknown;
      structuredContent?: unknown;
    };
    return { content, details, structuredContent, isError };
  }
  return { content: result, isError };
}
