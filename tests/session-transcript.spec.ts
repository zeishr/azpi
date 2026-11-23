import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileTail, applyEntry } from "../src/session-transcript";
import type { TranscriptStep } from "../src/session-transcript";

const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const assistant = (...content: object[]) => ({
  type: "message",
  message: { role: "assistant", content },
});
const toolResult = (toolCallId: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName: "bash", content: [], isError },
});

function sessionFile(): string {
  return join(mkdtempSync(join(tmpdir(), "azpi-")), "session.jsonl");
}

describe("applyEntry", () => {
  it("adds the assistant's text and tool calls, then settles each call with its result", () => {
    const steps: TranscriptStep[] = [];

    expect(
      applyEntry(
        steps,
        assistant(
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Let me look." },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "false" } },
        ),
      ),
    ).toBe(true);
    applyEntry(steps, toolResult("c1"));
    applyEntry(steps, toolResult("c2", true));

    expect(steps).toEqual([
      { kind: "text", text: "Let me look." },
      { kind: "tool", id: "c1", name: "read", args: { path: "a.ts" }, status: "completed" },
      { kind: "tool", id: "c2", name: "bash", args: { command: "false" }, status: "failed" },
    ]);
  });

  it("ignores entries a card does not show", () => {
    const steps: TranscriptStep[] = [];
    for (const entry of [
      { type: "session", cwd: "/repo" },
      { type: "model_change", modelId: "x" },
      { type: "message", message: { role: "user", content: "the task" } },
      assistant({ type: "text", text: "   " }),
      toolResult("unknown"),
    ]) {
      expect(applyEntry(steps, entry)).toBe(false);
    }
    expect(steps).toEqual([]);
  });
});

describe("SessionFileTail", () => {
  it("has nothing before the child writes its session file", () => {
    const tail = new SessionFileTail(sessionFile());
    expect(tail.refresh()).toBe(false);
    expect(tail.steps).toEqual([]);
  });

  it("reads only what was appended since the last look", () => {
    const path = sessionFile();
    writeFileSync(path, line({ type: "session", cwd: "/work" }));
    const tail = new SessionFileTail(path);

    expect(tail.refresh()).toBe(false);
    expect(tail.cwd).toBe("/work");

    appendFileSync(path, line(assistant({ type: "text", text: "first" })));
    expect(tail.refresh()).toBe(true);
    expect(tail.refresh()).toBe(false);

    appendFileSync(path, line(assistant({ type: "text", text: "second" })));
    expect(tail.refresh()).toBe(true);
    expect(tail.steps.map((step) => (step.kind === "text" ? step.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("waits for a line Pi is still writing", () => {
    const path = sessionFile();
    const entry = line(assistant({ type: "text", text: "été" }));
    // Cut inside the two-byte "é", so the character also straddles the reads.
    const bytes = Buffer.from(entry);
    const cut = bytes.indexOf(Buffer.from("é")) + 1;
    writeFileSync(path, bytes.subarray(0, cut));
    const tail = new SessionFileTail(path);

    expect(tail.refresh()).toBe(false);
    appendFileSync(path, bytes.subarray(cut));
    expect(tail.refresh()).toBe(true);
    expect(tail.steps).toEqual([{ kind: "text", text: "été" }]);
  });

  it("skips a corrupt line and keeps reading", () => {
    const path = sessionFile();
    writeFileSync(path, `{not json\n${line(assistant({ type: "text", text: "after" }))}`);
    const tail = new SessionFileTail(path);

    expect(tail.refresh()).toBe(true);
    expect(tail.steps).toEqual([{ kind: "text", text: "after" }]);
  });
});
