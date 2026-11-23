import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { SessionUpdateType } from "./session-update-types";
import { SessionFileTail } from "./session-transcript";
import type { TranscriptStep } from "./session-transcript";
import { childCard, runsSeveralChildren, subagentChildren } from "./subagent-cards";
import type { SubagentChild } from "./subagent-cards";
import { transcriptMarkdown } from "./transcript-view";
import type { PresentationContext, ToolOutcome } from "./tool-presentation";

/** Card key of a single child, which shows in the call's own card. */
const OWN_CARD = "";

interface Call {
  severalChildren: boolean;
  children: SubagentChild[];
  /** Last card sent, by child key, to resend only cards that changed. */
  sent: Map<string, { title: string; serialized: string }>;
  /** One reader per child session file, by child key. */
  tails: Map<string, SessionFileTail>;
}

/**
 * The cards of the `subagent` calls of one session, built from pi-subagents'
 * progress snapshots and from each child's session file, which holds its
 * transcript as it runs.
 *
 * A call running one agent shows it in its own card; a workflow opens one
 * card per child below. Snapshots do not come for everything a child does
 * (a workflow only reports state changes), so `poll` re-reads the session
 * files of the running calls in between.
 */
export class SubagentCalls {
  private readonly calls = new Map<string, Call>();

  constructor(private readonly context: PresentationContext) {}

  get running(): boolean {
    return this.calls.size > 0;
  }

  start(toolCallId: string, args: unknown): void {
    this.calls.set(toolCallId, newCall(args));
  }

  progress(toolCallId: string, details: unknown): SessionUpdate[] {
    const call = this.calls.get(toolCallId);
    if (!call) return [];
    call.children = subagentChildren(details);
    this.refreshTails(call);
    return this.cardUpdates(toolCallId, call);
  }

  /** Re-reads the children's session files, updating the cards whose transcript grew. */
  poll(): SessionUpdate[] {
    return [...this.calls].flatMap(([toolCallId, call]) =>
      this.refreshTails(call) ? this.cardUpdates(toolCallId, call) : [],
    );
  }

  /**
   * Settles a call's children. A workflow's child cards come as updates; a
   * single child's view comes as the content that heads the call's result.
   */
  end(
    toolCallId: string,
    args: unknown,
    outcome: ToolOutcome,
  ): { updates: SessionUpdate[]; ownContent: ToolCallContent[] } {
    // A replayed call that never started live has no state yet.
    const call = this.calls.get(toolCallId) ?? newCall(args);
    this.calls.delete(toolCallId);
    call.children = subagentChildren(outcome.details);
    this.refreshTails(call);
    const callStatus = outcome.isError ? "failed" : "completed";

    if (call.severalChildren) {
      return { updates: this.childCardUpdates(toolCallId, call, callStatus), ownContent: [] };
    }
    const [child] = call.children;
    if (!child) return { updates: [], ownContent: [] };
    const transcript = this.transcriptOf(call, child);
    // The output the parent model received follows in the result: not repeated here.
    const card = childCard(child, { callStatus, includeOutput: false, transcript });
    return { updates: [], ownContent: card.content };
  }

  private cardUpdates(toolCallId: string, call: Call): SessionUpdate[] {
    return call.severalChildren
      ? this.childCardUpdates(toolCallId, call)
      : this.ownCardUpdate(toolCallId, call);
  }

  private ownCardUpdate(toolCallId: string, call: Call): SessionUpdate[] {
    const [child] = call.children;
    if (!child) return [];
    const transcript = this.transcriptOf(call, child);
    const { content } = childCard(child, { includeOutput: false, transcript });
    const serialized = JSON.stringify(content);
    if (call.sent.get(OWN_CARD)?.serialized === serialized) return [];
    call.sent.set(OWN_CARD, { title: "", serialized });
    return [
      {
        sessionUpdate: SessionUpdateType.ToolCallUpdate,
        toolCallId,
        status: "in_progress",
        content,
      },
    ];
  }

  private childCardUpdates(
    toolCallId: string,
    call: Call,
    callStatus?: "completed" | "failed",
  ): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    for (const child of call.children) {
      const previous = call.sent.get(child.key);
      const transcript = this.transcriptOf(call, child);
      const fresh = childCard(child, { callStatus, includeOutput: true, transcript });
      // Snapshots do not always repeat a child's agent: keep the best title seen.
      const card = { ...fresh, title: fresh.title ?? previous?.title ?? "subagent" };
      const serialized = JSON.stringify(card);
      if (previous?.serialized === serialized) continue;
      call.sent.set(child.key, { title: card.title, serialized });

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

  /** Reads what the children's session files gained; true when a transcript changed. */
  private refreshTails(call: Call): boolean {
    let changed = false;
    for (const child of call.children) {
      if (!child.sessionFile) continue;
      let tail = call.tails.get(child.key);
      if (tail?.path !== child.sessionFile) {
        tail = new SessionFileTail(child.sessionFile);
        call.tails.set(child.key, tail);
      }
      changed = tail.refresh() || changed;
    }
    return changed;
  }

  private transcriptOf(call: Call, child: SubagentChild): string | undefined {
    const tail = call.tails.get(child.key);
    if (!tail) return undefined;
    // A finished child's last words are its output, which follows in full.
    const finished = child.status === "completed" || child.status === "failed";
    const steps = finished ? withoutClosingText(tail.steps) : tail.steps;
    // The child's tool calls are titled from its own working directory.
    const context = { cwd: tail.cwd ?? this.context.cwd, live: false };
    return transcriptMarkdown(steps, context) || undefined;
  }
}

function withoutClosingText(steps: TranscriptStep[]): TranscriptStep[] {
  let end = steps.length;
  while (end > 0 && steps[end - 1]!.kind === "text") end -= 1;
  return steps.slice(0, end);
}

function newCall(args: unknown): Call {
  return {
    severalChildren: runsSeveralChildren(args),
    children: [],
    sent: new Map(),
    tails: new Map(),
  };
}
