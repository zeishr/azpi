import { describe, expect, it } from "bun:test";
import type { TranscriptStep } from "../src/session-transcript";
import { transcriptMarkdown } from "../src/transcript-view";

const context = { cwd: "/repo", live: false };
const tool = (
  name: string,
  args: object,
  status: "running" | "completed" | "failed" = "completed",
): TranscriptStep => ({ kind: "tool", id: name, name, args, status });

describe("transcriptMarkdown", () => {
  it("lists steps titled like the parent's tool cards", () => {
    const steps: TranscriptStep[] = [
      { kind: "text", text: "Checking the parser.\nMore detail." },
      tool("read", { path: "/repo/src/parser.rs" }),
      tool("grep", { pattern: "TODO", path: "src" }),
    ];
    expect(transcriptMarkdown(steps, context)).toBe(
      ["- Checking the parser. …", "- Read src/parser.rs", "- Grep `TODO` in src"].join("\n"),
    );
  });

  it("shows commands as code, since the list is Markdown", () => {
    expect(transcriptMarkdown([tool("bash", { command: "cargo test\n--all" })], context)).toBe(
      "- Run `cargo test …`",
    );
  });

  it("marks running and failed calls", () => {
    const steps = [
      tool("bash", { command: "make" }, "failed"),
      tool("read", { path: "a.ts" }, "running"),
    ];
    expect(transcriptMarkdown(steps, context)).toBe("- Run `make` (failed)\n- Read a.ts …");
  });

  it("keeps the last steps and counts the earlier ones", () => {
    const steps = Array.from({ length: 15 }, (_, index) => tool("read", { path: `f${index}.ts` }));
    const lines = transcriptMarkdown(steps, context).split("\n");
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe("- … 3 earlier steps");
    expect(lines.at(-1)).toBe("- Read f14.ts");
  });

  it("shortens long text", () => {
    const [line] = transcriptMarkdown([{ kind: "text", text: "x".repeat(500) }], context).split(
      "\n",
    );
    expect(line!.length).toBe(202);
    expect(line!.endsWith("…")).toBe(true);
  });

  it("is empty for an empty transcript", () => {
    expect(transcriptMarkdown([], context)).toBe("");
  });
});
