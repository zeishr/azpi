import type { SessionUpdate, ToolCallStatus } from "@agentclientprotocol/sdk";
import { SessionUpdateType } from "./session-update-types";
import {
  HIDDEN_NESTED_TOOLS,
  SUBAGENT_TOOL,
  childCard,
  runsSeveralChildren,
  subagentChildren,
} from "./subagent-cards";
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
 * A `subagent` call that runs several children also gets one card per child,
 * created as each child shows up and updated only when its card changes.
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
   * than what a card shows changes (a subagent's every event, for instance).
   */
  private readonly lastProgress = new Map<string, string>();
  /** Display terminals of the bash calls still running, by tool call id. */
  private readonly terminals = new Map<string, TerminalMirror>();
  /** Last card sent for each child, by parent tool call id then child key. */
  private readonly childCards = new Map<
    string,
    Map<string, { title: string; serialized: string }>
  >();

  constructor(private readonly context: PresentationContext) {}

  start(toolCallId: string, name: string, args: unknown, status: ToolCallStatus): SessionUpdate[] {
    this.calls.set(toolCallId, { name, args });
    if (HIDDEN_NESTED_TOOLS.has(name)) return [];
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

    const updates = this.childCardUpdates(toolCallId, name, args, partial.details);
    const content = presentToolProgress(name, args, partial, this.context);
    const serialized = JSON.stringify(content);
    if (content !== undefined && serialized !== this.lastProgress.get(toolCallId)) {
      this.lastProgress.set(toolCallId, serialized);
      updates.push({
        sessionUpdate: SessionUpdateType.ToolCallUpdate,
        toolCallId,
        status: "in_progress",
        content,
      });
    }
    return updates;
  }

  end(
    toolCallId: string,
    fallbackName: string,
    result: unknown,
    isError: boolean,
  ): SessionUpdate[] {
    const call = this.calls.get(toolCallId) ?? { name: fallbackName, args: undefined };
    this.calls.delete(toolCallId);
    if (HIDDEN_NESTED_TOOLS.has(call.name)) return [];
    const outcome = toOutcome(result, isError);
    const status = isError ? "failed" : "completed";
    const updates = this.childCardUpdates(
      toolCallId,
      call.name,
      call.args,
      outcome.details,
      status,
    );
    this.childCards.delete(toolCallId);
    this.lastProgress.delete(toolCallId);

    const terminal = this.terminals.get(toolCallId);
    if (terminal) {
      this.terminals.delete(toolCallId);
      const output = terminal.finish(outcome);
      updates.push({
        sessionUpdate: SessionUpdateType.ToolCallUpdate,
        toolCallId,
        status,
        _meta: {
          ...(output ? { terminal_output: { terminal_id: toolCallId, data: output } } : {}),
          terminal_exit: { terminal_id: toolCallId, ...exitStatusOf(outcome) },
        },
      });
      return updates;
    }

    const content = presentToolResult(call.name, call.args, outcome, this.context);
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

  private childCardUpdates(
    toolCallId: string,
    name: string,
    args: unknown,
    details: unknown,
    callStatus?: "completed" | "failed",
  ): SessionUpdate[] {
    if (name !== SUBAGENT_TOOL || !runsSeveralChildren(args)) return [];
    const sent =
      this.childCards.get(toolCallId) ?? new Map<string, { title: string; serialized: string }>();
    this.childCards.set(toolCallId, sent);

    const updates: SessionUpdate[] = [];
    for (const child of subagentChildren(details)) {
      const previous = sent.get(child.key);
      const fresh = childCard(child, { callStatus, includeOutput: true });
      // Snapshots do not always repeat a child's agent: keep the best title seen.
      const card = { ...fresh, title: fresh.title ?? previous?.title ?? "subagent" };
      const serialized = JSON.stringify(card);
      if (previous?.serialized === serialized) continue;
      sent.set(child.key, { title: card.title, serialized });

      // Pi names nested calls `<parent id>/<n>`; child cards follow the same scheme.
      const childCallId = `${toolCallId}/child-${child.key}`;
      updates.push(
        previous === undefined
          ? {
              sessionUpdate: SessionUpdateType.ToolCall,
              toolCallId: childCallId,
              kind: "think",
              ...card,
            }
          : { sessionUpdate: SessionUpdateType.ToolCallUpdate, toolCallId: childCallId, ...card },
      );
    }
    return updates;
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
