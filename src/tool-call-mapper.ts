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

/**
 * Builds the ACP tool call notifications of one session.
 *
 * Pi reports a tool's name and arguments when it starts but not with its
 * result, while the result card needs both (an edit's diff comes from its
 * arguments), so the mapper keeps them until the call ends.
 *
 * A `subagent` call that runs several children also gets one card per child,
 * created as each child shows up and updated only when its card changes.
 */
export class ToolCallMapper {
  private readonly calls = new Map<string, { name: string; args: unknown }>();
  /**
   * Last progress content sent per call. Tools report progress far more often
   * than what a card shows changes (a subagent's every event, for instance).
   */
  private readonly lastProgress = new Map<string, string>();
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
    return [
      {
        sessionUpdate: SessionUpdateType.ToolCall,
        toolCallId,
        title: view.title,
        kind: view.kind,
        status,
        locations: view.locations,
        content: view.content,
        rawInput: args,
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

/**
 * Normalizes what Pi hands over as a result: an AgentToolResult or a stored
 * ToolResultMessage (both `{ content, details }`), or a bare value.
 */
function toOutcome(result: unknown, isError: boolean): ToolOutcome {
  if (result && typeof result === "object" && ("content" in result || "details" in result)) {
    const { content, details } = result as { content: unknown; details?: unknown };
    return { content, details, isError };
  }
  return { content: result, isError };
}
