import type { ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";

/**
 * Reads the foreground progress of pi-subagents' `subagent` tool and turns
 * each child into what a tool card shows.
 *
 * Relies on the documented parts of its result details: for workflows (which
 * is how several children run), the versioned `workflowChildren` summary,
 * live and keyed by `childId`; for a single agent, the `results[]` and
 * `progress[]` rows keyed by an `index` stable across snapshots.
 */

export const SUBAGENT_TOOL = "subagent";

/**
 * Nested calls a workflow makes to record each child launch. They start
 * nothing and the child card already shows the launch, so they stay hidden.
 */
export const HIDDEN_NESTED_TOOLS = new Set(["subagent_launch"]);

const RECENT_TOOLS_SHOWN = 5;
const MAX_TITLE_LENGTH = 120;

/**
 * Pi-subagents redacts the task in its progress and result rows, so a child
 * is named by its session name (agent and task excerpt) or its agent.
 */
export interface SubagentChild {
  /** Stable within one call: the workflow childId, or the index of a single run. */
  key: string;
  agent?: string;
  sessionName?: string;
  /** The child's own session file, which carries its transcript while it runs. */
  sessionFile?: string;
  model?: string;
  thinking?: string;
  status: "pending" | "running" | "completed" | "failed" | "detached";
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: Array<{ tool: string; args: string }>;
  progressText?: string;
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
  finalOutput?: string;
}

export interface ChildCard {
  /** Undefined while nothing names the child yet: snapshots may omit its agent. */
  title: string | undefined;
  status: ToolCallStatus;
  content: ToolCallContent[];
}

type Row = Record<string, unknown>;

/**
 * A call that may run several children gets one card per child; a call with
 * a single agent shows that child in its own card.
 */
export function runsSeveralChildren(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const { tasks, chain, workflow } = args as Row;
  return (
    tasks !== undefined || chain !== undefined || (workflow !== undefined && workflow !== false)
  );
}

export function subagentTitle(args: Row): string {
  const background = args.async === true ? " (background)" : "";
  if (typeof args.action === "string") {
    return `subagent ${args.action}${typeof args.id === "string" ? ` ${args.id}` : ""}`;
  }
  // The built-in `parallel` and `chain` workflows take their steps in `args`;
  // older releases accepted them at the top level.
  const workflowArgs = rowOf(args.args) ?? {};
  const chain = workflowArgs.chain ?? args.chain;
  const tasks = workflowArgs.tasks ?? args.tasks;
  if (Array.isArray(chain)) {
    return `Subagent chain: ${agentsOf(chain).join(" → ")}${background}`;
  }
  if (Array.isArray(tasks)) {
    return `Subagents in parallel: ${agentsOf(tasks).join(", ")}${background}`;
  }
  if (args.workflow !== undefined) {
    const name = typeof args.workflow === "string" ? args.workflow : "inline script";
    return `Workflow: ${name}${background}`;
  }
  const agent = typeof args.agent === "string" ? args.agent : "subagent";
  const task = typeof args.task === "string" ? firstLine(args.task) : "";
  return `${agent}${task ? `: ${task}` : ""}${background}`;
}

/** Children of a `subagent` result or progress snapshot, in launch order. */
export function subagentChildren(details: unknown): SubagentChild[] {
  if (!details || typeof details !== "object") return [];
  const { results, progress, workflowChildren } = details as Row;
  const summary = rowOf(workflowChildren);
  if (summary?.version === 1 && Array.isArray(summary.children)) {
    return workflowChildrenOf(summary.children, rowsOf(results, false));
  }
  return indexedChildren(rowsOf(results), rowsOf(progress));
}

/**
 * Workflow children from the live summary. Each child is a run of its own,
 * so every result row has index 0: rows are matched by workflowKey instead.
 */
function workflowChildrenOf(children: unknown[], results: Row[]): SubagentChild[] {
  return rowsOf(children, false)
    .filter((row) => typeof row.childId === "string")
    .map((row) => {
      const result = results.find((candidate) => candidate.workflowKey === row.childId) ?? {};
      const activity = rowOf(row.activity);
      return {
        key: row.childId as string,
        agent: stringOf(row.agent) ?? stringOf(result.agent),
        sessionName: stringOf(row.sessionName) ?? stringOf(result.sessionName),
        sessionFile: stringOf(row.sessionFile) ?? stringOf(result.sessionFile),
        model: stringOf(row.model) ?? stringOf(result.model),
        thinking: stringOf(row.thinking) ?? stringOf(result.thinking),
        status: workflowStatus(row.state),
        currentTool: stringOf(activity?.currentTool),
        recentTools: [],
        toolCount: numberOf(activity?.toolCount),
        tokens: numberOf(activity?.tokens),
        durationMs: numberOf(activity?.durationMs),
        error: stringOf(result.error),
        finalOutput: stringOf(result.finalOutput),
      };
    });
}

function workflowStatus(state: unknown): SubagentChild["status"] {
  switch (state) {
    case "pending":
    case "completed":
    case "failed":
    case "detached":
      return state;
    // A paused child waits on something, such as a supervisor answer.
    case "running":
    case "paused":
      return "running";
    default:
      // stopped, rejected
      return "failed";
  }
}

/** A single run's children, merging each result row with its progress row. */
function indexedChildren(results: Row[], progressRows: Row[]): SubagentChild[] {
  const byIndex = new Map<number, { result?: Row; progress?: Row }>();
  for (const row of results) {
    byIndex.set(row.index as number, { ...byIndex.get(row.index as number), result: row });
  }
  for (const row of progressRows) {
    byIndex.set(row.index as number, { ...byIndex.get(row.index as number), progress: row });
  }
  return [...byIndex.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([index, { result = {}, progress }]) =>
      // A final result row carries its counters in progressSummary instead.
      toChild(
        String(index),
        result,
        progress ?? rowOf(result.progress) ?? rowOf(result.progressSummary),
      ),
    );
}

export function childTitle(child: SubagentChild): string | undefined {
  const title = child.sessionName ?? child.agent;
  if (!title) return undefined;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

export interface ChildCardOptions {
  callStatus?: "completed" | "failed";
  includeOutput: boolean;
  /** The end of the child's transcript, as Markdown, when its session file could be read. */
  transcript?: string;
}

/**
 * The card of one child. Once the parent call ended, a child still marked
 * running was cut short with it, so it takes the call's final status.
 */
export function childCard(child: SubagentChild, options: ChildCardOptions): ChildCard {
  const status = cardStatus(child.status, options.callStatus);
  const done = status === "completed" || status === "failed";
  const lines = done
    ? doneLines(child, options.includeOutput, options.transcript)
    : liveLines(child, options.transcript);
  const text = lines.join("\n\n");
  return {
    title: childTitle(child),
    status,
    content: text ? [{ type: "content", content: { type: "text", text } }] : [],
  };
}

function cardStatus(
  status: SubagentChild["status"],
  callStatus: "completed" | "failed" | undefined,
): ToolCallStatus {
  switch (status) {
    case "completed":
    // A detached child keeps running in the background; this card is done.
    case "detached":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return callStatus ?? "pending";
    case "running":
      return callStatus ?? "in_progress";
  }
}

/**
 * The transcript, when there is one, shows every step including the running
 * one; otherwise the progress rows give the current tool and the last few.
 */
function liveLines(child: SubagentChild, transcript: string | undefined): string[] {
  const lines = [statsLine(child, false)];
  if (transcript) {
    lines.push(transcript);
  } else {
    if (child.currentTool) {
      lines.push(`Running ${toolLabel(child.currentTool, child.currentToolArgs)}`);
    }
    const recent = child.recentTools.slice(-RECENT_TOOLS_SHOWN);
    if (recent.length > 0) {
      lines.push(recent.map(({ tool, args }) => `- ${toolLabel(tool, args)}`).join("\n"));
    }
  }
  if (child.progressText) lines.push(`Progress: ${child.progressText}`);
  if (child.error) lines.push(`**Error:** ${child.error}`);
  return lines.filter(Boolean);
}

function doneLines(
  child: SubagentChild,
  includeOutput: boolean,
  transcript: string | undefined,
): string[] {
  const lines = [statsLine(child, true)];
  if (child.status === "detached") lines.push("Continues in the background.");
  if (transcript) lines.push(transcript);
  if (child.error) lines.push(`**Error:** ${child.error}`);
  if (includeOutput && child.finalOutput) lines.push(child.finalOutput);
  return lines.filter(Boolean);
}

/**
 * Model, effort and counters on one line. The live variant leaves out the
 * duration: it changes on every snapshot and would resend the card each time.
 */
function statsLine(child: SubagentChild, withDuration: boolean): string {
  const parts = [
    child.model && `\`${child.model}\``,
    child.thinking && `thinking ${child.thinking}`,
    child.toolCount !== undefined && `${child.toolCount} tool${child.toolCount === 1 ? "" : "s"}`,
    child.tokens !== undefined && `${formatTokens(child.tokens)} tokens`,
    withDuration && child.durationMs !== undefined && formatDuration(child.durationMs),
  ];
  return parts.filter(Boolean).join(" · ");
}

function toChild(key: string, result: Row, progress: Row | undefined): SubagentChild {
  return {
    key,
    agent: stringOf(result.agent) ?? stringOf(progress?.agent),
    sessionName: stringOf(result.sessionName) ?? stringOf(progress?.sessionName),
    sessionFile: stringOf(progress?.sessionFile) ?? stringOf(result.sessionFile),
    model: stringOf(progress?.model) ?? stringOf(result.model),
    thinking: stringOf(progress?.thinking) ?? stringOf(result.thinking),
    status: statusOf(result, progress),
    currentTool: stringOf(progress?.currentTool),
    currentToolArgs: stringOf(progress?.currentToolArgs),
    recentTools: rowsOf(progress?.recentTools, false).map((row) => ({
      tool: stringOf(row.tool) ?? "tool",
      args: stringOf(row.args) ?? "",
    })),
    progressText: stringOf(progress?.progressText),
    toolCount: numberOf(progress?.toolCount),
    tokens: numberOf(progress?.tokens),
    durationMs: numberOf(progress?.durationMs),
    error: stringOf(result.error) ?? stringOf(progress?.error),
    finalOutput: stringOf(result.finalOutput),
  };
}

/** The progress row is authoritative while it exists; a bare result row only has an exit code. */
function statusOf(result: Row, progress: Row | undefined): SubagentChild["status"] {
  const status = progress?.status;
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "detached"
  ) {
    return status;
  }
  if (result.detached === true) return "detached";
  if (typeof result.exitCode === "number") return result.exitCode === 0 ? "completed" : "failed";
  return "running";
}

function rowsOf(value: unknown, requireIndex = true): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Row =>
      Boolean(row) && typeof row === "object" && (!requireIndex || typeof row.index === "number"),
  );
}

function rowOf(value: unknown): Row | undefined {
  return value && typeof value === "object" ? (value as Row) : undefined;
}

function agentsOf(steps: unknown[]): string[] {
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const { agent, parallel } = step as Row;
    if (Array.isArray(parallel)) return [`(${agentsOf(parallel).join(" + ")})`];
    return typeof agent === "string" ? [agent] : [];
  });
}

function toolLabel(tool: string, args: string | undefined): string {
  const detail = args ? firstLine(args) : "";
  return `\`${tool}\`${detail ? ` ${detail}` : ""}`;
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
