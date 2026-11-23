import { describe, expect, it } from "bun:test";
import { TerminalMirror, exitStatusOf } from "../src/terminal-mirror";
import type { ToolOutcome } from "../src/tool-presentation";

const snapshot = (text: string): ToolOutcome => ({
  content: [{ type: "text", text }],
  isError: false,
});

describe("TerminalMirror", () => {
  it("appends only what each snapshot adds", () => {
    const mirror = new TerminalMirror("t1");
    expect(mirror.progress(snapshot("a"))).toBe("a");
    expect(mirror.progress(snapshot("ab"))).toBe("b");
    expect(mirror.progress(snapshot("ab"))).toBeUndefined();
  });

  it("catches up from the full output once the call ended", () => {
    const mirror = new TerminalMirror("t1");
    mirror.progress(snapshot("line 1\n"));
    const end: ToolOutcome = {
      content: [{ type: "text", text: "line 2\n" }],
      structuredContent: { output: "line 1\nline 2\n", exit_code: 0 },
      isError: false,
    };
    expect(mirror.finish(end)).toBe("line 2\n");
  });

  it("pauses once Pi truncates the head of long output, then catches up at the end", () => {
    const mirror = new TerminalMirror("t1");
    mirror.progress(snapshot("1\n2\n"));
    // Pi keeps only the tail of long output in its snapshots.
    expect(mirror.progress(snapshot("2\n3\n"))).toBeUndefined();
    expect(mirror.progress(snapshot("1\n2\n3\n4\n"))).toBeUndefined();

    const end: ToolOutcome = {
      content: [{ type: "text", text: "3\n4\n5\n" }],
      structuredContent: { output: "1\n2\n3\n4\n5\n", exit_code: 0 },
      isError: false,
    };
    expect(mirror.finish(end)).toBe("3\n4\n5\n");
  });

  it("ends a command that failed to complete with its status line", () => {
    const mirror = new TerminalMirror("t1");
    mirror.progress(snapshot("waiting\n"));
    // A timeout or an abort throws: Pi has only the text, output then reason.
    const failed: ToolOutcome = {
      content: [{ type: "text", text: "waiting\n\n\nCommand timed out after 2 seconds" }],
      isError: true,
    };
    expect(mirror.finish(failed)).toBe("\n\nCommand timed out after 2 seconds");
  });

  it("adds nothing when the end does not extend what it showed", () => {
    const mirror = new TerminalMirror("t1");
    mirror.progress(snapshot("abc"));
    expect(mirror.finish(snapshot("xyz"))).toBeUndefined();
  });
});

describe("exitStatusOf", () => {
  it("reports the exit code of a command that ran to its end", () => {
    const outcome: ToolOutcome = {
      content: [],
      structuredContent: { output: "", exit_code: 2 },
      isError: true,
    };
    expect(exitStatusOf(outcome)).toEqual({ exit_code: 2, signal: null });
  });

  it("has no exit code for a command that never completed", () => {
    expect(exitStatusOf({ content: [], isError: true })).toEqual({ exit_code: null, signal: null });
  });
});
