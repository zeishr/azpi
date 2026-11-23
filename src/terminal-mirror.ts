import { textOf } from "./tool-presentation";
import type { ToolOutcome } from "./tool-presentation";

/**
 * Follows the output of one bash call so a client can show it in a terminal
 * it only displays (Zed's `_meta.terminal_*` convention), while Pi runs the
 * command itself.
 *
 * Pi reports bash progress as snapshots of the whole output so far, but a
 * display terminal only appends. The mirror sends what each snapshot adds,
 * and the rest once the command ended. When Pi starts truncating the head of
 * long output, snapshots stop extending each other: live mirroring pauses
 * and the end of the call catches up from the full output.
 */
export class TerminalMirror {
  private shown = "";
  private following = true;

  constructor(readonly terminalId: string) {}

  /** Output to append for a partial result, or undefined when there is none. */
  progress(partial: ToolOutcome): string | undefined {
    if (!this.following) return undefined;
    const snapshot = textOf(partial.content);
    if (!snapshot.startsWith(this.shown)) {
      this.following = false;
      return undefined;
    }
    return this.append(snapshot);
  }

  /**
   * Output still to append once the call ended. A failed call's text also
   * carries its status line (a timeout, an abort) after the output.
   */
  finish(outcome: ToolOutcome): string | undefined {
    const full = fullOutputOf(outcome);
    if (!full.startsWith(this.shown)) return undefined;
    return this.append(full);
  }

  private append(snapshot: string): string | undefined {
    const added = snapshot.slice(this.shown.length);
    this.shown = snapshot;
    return added || undefined;
  }
}

/** The exit status to report for a bash call, as the convention spells it. */
export function exitStatusOf(outcome: ToolOutcome): { exit_code: number | null; signal: null } {
  const exitCode = structuredField(outcome, "exit_code");
  return { exit_code: typeof exitCode === "number" ? exitCode : null, signal: null };
}

/**
 * Pi's bash returns its whole output, up to a large bound, as structured
 * content next to the model-facing text, which keeps only the tail and adds
 * a status line. A call that threw (a timeout, an abort) has only that text,
 * whose status line then tells why the command stopped.
 */
function fullOutputOf(outcome: ToolOutcome): string {
  const output = structuredField(outcome, "output");
  return typeof output === "string" ? output : textOf(outcome.content);
}

function structuredField(outcome: ToolOutcome, field: string): unknown {
  const structured = outcome.structuredContent;
  if (!structured || typeof structured !== "object") return undefined;
  return (structured as Record<string, unknown>)[field];
}
