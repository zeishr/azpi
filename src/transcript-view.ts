import type { TranscriptStep } from "./session-transcript";
import { inlineCode, presentToolCall } from "./tool-presentation";
import type { PresentationContext } from "./tool-presentation";

/**
 * Renders the end of a child's transcript as a Markdown list for its card:
 * the steps it took, the latest last, titled like the parent's own tool cards.
 */

/** Enough to follow what a child is doing without the card growing with its whole run. */
const STEPS_SHOWN = 12;
const TEXT_EXCERPT_LENGTH = 200;

export function transcriptMarkdown(steps: TranscriptStep[], context: PresentationContext): string {
  if (steps.length === 0) return "";
  const shown = steps.slice(-STEPS_SHOWN);
  const hidden = steps.length - shown.length;
  const lines = shown.map((step) => `- ${stepLabel(step, context)}`);
  if (hidden > 0) lines.unshift(`- … ${hidden} earlier step${hidden === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function stepLabel(step: TranscriptStep, context: PresentationContext): string {
  if (step.kind === "text") return excerpt(step.text);
  const view = presentToolCall(step.name, step.args, context);
  // Clients show a command title as plain text; this list is Markdown.
  const label = view.kind === "execute" ? `Run ${inlineCode(firstLine(view.title))}` : view.title;
  return `${label}${statusSuffix(step.status)}`;
}

function statusSuffix(status: "running" | "completed" | "failed"): string {
  if (status === "running") return " …";
  return status === "failed" ? " (failed)" : "";
}

function excerpt(text: string): string {
  const line = firstLine(text);
  return line.length > TEXT_EXCERPT_LENGTH ? `${line.slice(0, TEXT_EXCERPT_LENGTH - 1)}…` : line;
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}
