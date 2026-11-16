import type { ToolCall, ToolCallStatus, ToolCallUpdate } from "@agentclientprotocol/sdk";
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
 */
export class ToolCallMapper {
  private readonly calls = new Map<string, { name: string; args: unknown }>();

  constructor(private readonly context: PresentationContext) {}

  start(toolCallId: string, name: string, args: unknown, status: ToolCallStatus): ToolCall {
    this.calls.set(toolCallId, { name, args });
    const view = presentToolCall(name, args, this.context);
    return {
      toolCallId,
      title: view.title,
      kind: view.kind,
      status,
      locations: view.locations,
      content: view.content,
      rawInput: args,
    };
  }

  /** Returns null when the partial result would not change what the card shows. */
  progress(
    toolCallId: string,
    name: string,
    args: unknown,
    partialResult: unknown,
  ): ToolCallUpdate | null {
    const content = presentToolProgress(name, args, toOutcome(partialResult, false), this.context);
    if (content === undefined) return null;
    return { toolCallId, status: "in_progress", content };
  }

  end(toolCallId: string, fallbackName: string, result: unknown, isError: boolean): ToolCallUpdate {
    const call = this.calls.get(toolCallId) ?? { name: fallbackName, args: undefined };
    this.calls.delete(toolCallId);
    const outcome = toOutcome(result, isError);
    const content = presentToolResult(call.name, call.args, outcome, this.context);
    const locations = presentResultLocations(call.name, call.args, outcome, this.context);
    return {
      toolCallId,
      status: isError ? "failed" : "completed",
      ...(content === undefined ? {} : { content }),
      ...(locations === undefined ? {} : { locations }),
    };
  }
}

/**
 * Normalizes what Pi hands over as a result: an AgentToolResult or a stored
 * ToolResultMessage (both `{ content, details }`), or a bare value.
 */
function toOutcome(result: unknown, isError: boolean): ToolOutcome {
  if (result && typeof result === "object" && "content" in result) {
    const { content, details } = result as { content: unknown; details?: unknown };
    return { content, details, isError };
  }
  return { content: result, isError };
}
