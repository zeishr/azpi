import { describe, expect, it } from "bun:test";
import { ToolCallMapper } from "../src/tool-call-mapper";

const live = () => new ToolCallMapper({ cwd: "/repo", live: true });

describe("ToolCallMapper", () => {
  describe("start", () => {
    it("describes the call and keeps its raw input", () => {
      const call = live().start("tc-1", "read", { path: "src/a.ts" }, "in_progress");
      expect(call).toEqual({
        toolCallId: "tc-1",
        title: "Read src/a.ts",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/src/a.ts" }],
        content: [],
        rawInput: { path: "src/a.ts" },
      });
    });
  });

  describe("progress", () => {
    it("shows the partial text of a generic tool", () => {
      const update = live().progress(
        "tc-1",
        "custom_tool",
        {},
        {
          content: [{ type: "text", text: "halfway" }],
        },
      );
      expect(update).toEqual({
        toolCallId: "tc-1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "halfway" } }],
      });
    });

    it("returns null when the presenter keeps the current content", () => {
      const update = live().progress(
        "tc-1",
        "bash",
        { command: "make" },
        {
          content: [{ type: "text", text: "..." }],
          details: { terminalId: "t1" },
        },
      );
      expect(update).toBeNull();
    });
  });

  describe("end", () => {
    it("marks a successful call completed", () => {
      const mapper = live();
      mapper.start("tc-1", "custom_tool", {}, "in_progress");
      const update = mapper.end(
        "tc-1",
        "custom_tool",
        { content: [{ type: "text", text: "ok" }] },
        false,
      );
      expect(update.status).toBe("completed");
      expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
    });

    it("marks a failed call failed and shows the error", () => {
      const mapper = live();
      mapper.start("tc-1", "write", { path: "a.txt", content: "x" }, "in_progress");
      const update = mapper.end(
        "tc-1",
        "write",
        { content: [{ type: "text", text: "EACCES: permission denied" }] },
        true,
      );
      expect(update.status).toBe("failed");
      expect(update.content).toEqual([
        { type: "content", content: { type: "text", text: "EACCES: permission denied" } },
      ]);
    });

    it("accepts a bare error object as result", () => {
      const update = live().end("tc-1", "custom_tool", { error: "boom" }, true);
      expect(update.content).toEqual([
        { type: "content", content: { type: "text", text: "boom" } },
      ]);
    });

    it("still ends a call it never saw start, using the event's tool name", () => {
      const update = live().end(
        "unknown",
        "read",
        { content: [{ type: "text", text: "x" }] },
        false,
      );
      expect(update.status).toBe("completed");
      expect(update.content).toEqual([
        { type: "content", content: { type: "text", text: "```\nx\n```" } },
      ]);
    });

    it("forgets the call once ended", () => {
      const mapper = live();
      mapper.start("tc-1", "read", { path: "a.rs" }, "in_progress");
      mapper.end("tc-1", "read", { content: [{ type: "text", text: "1" }] }, false);
      // Without the remembered path the result loses its language hint.
      const again = mapper.end("tc-1", "read", { content: [{ type: "text", text: "1" }] }, false);
      expect(again.content).toEqual([
        { type: "content", content: { type: "text", text: "```\n1\n```" } },
      ]);
    });
  });
});
