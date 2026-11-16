import { describe, expect, it } from "bun:test";
import { ToolCallMapper } from "../src/tool-call-mapper";

/** Fields of a tool_call_update, read without narrowing the SessionUpdate union in each test. */
type UpdateFields = { status?: string; content?: unknown; locations?: unknown };

const live = () => new ToolCallMapper({ cwd: "/repo", live: true });

describe("ToolCallMapper", () => {
  describe("start", () => {
    it("describes the call and keeps its raw input", () => {
      const call = live().start("tc-1", "read", { path: "src/a.ts" }, "in_progress");
      expect(call).toEqual([
        {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Read src/a.ts",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/src/a.ts" }],
          content: [],
          rawInput: { path: "src/a.ts" },
        },
      ]);
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
      expect(update).toEqual([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: "halfway" } }],
        },
      ]);
    });

    it("skips a partial result that would not change the card", () => {
      const mapper = live();
      const partial = { content: [{ type: "text", text: "same" }] };
      expect(mapper.progress("tc-1", "custom_tool", {}, partial)).toHaveLength(1);
      expect(mapper.progress("tc-1", "custom_tool", {}, partial)).toEqual([]);
      expect(
        mapper.progress("tc-1", "custom_tool", {}, { content: [{ type: "text", text: "new" }] }),
      ).toHaveLength(1);
    });

    it("sends nothing when the presenter keeps the current content", () => {
      const update = live().progress(
        "tc-1",
        "bash",
        { command: "make" },
        {
          content: [{ type: "text", text: "..." }],
          details: { terminalId: "t1" },
        },
      );
      expect(update).toEqual([]);
    });
  });

  describe("end", () => {
    it("marks a successful call completed", () => {
      const mapper = live();
      mapper.start("tc-1", "custom_tool", {}, "in_progress");
      const [update] = <UpdateFields[]>(
        mapper.end("tc-1", "custom_tool", { content: [{ type: "text", text: "ok" }] }, false)
      );
      expect(update!.status).toBe("completed");
      expect(update!.content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
    });

    it("marks a failed call failed and shows the error", () => {
      const mapper = live();
      mapper.start("tc-1", "write", { path: "a.txt", content: "x" }, "in_progress");
      const [update] = <UpdateFields[]>(
        mapper.end(
          "tc-1",
          "write",
          { content: [{ type: "text", text: "EACCES: permission denied" }] },
          true,
        )
      );
      expect(update!.status).toBe("failed");
      expect(update!.content).toEqual([
        { type: "content", content: { type: "text", text: "EACCES: permission denied" } },
      ]);
    });

    it("accepts a bare error object as result", () => {
      const [update] = <UpdateFields[]>live().end("tc-1", "custom_tool", { error: "boom" }, true);
      expect(update!.content).toEqual([
        { type: "content", content: { type: "text", text: "boom" } },
      ]);
    });

    it("still ends a call it never saw start, using the event's tool name", () => {
      const [update] = <UpdateFields[]>(
        live().end("unknown", "read", { content: [{ type: "text", text: "x" }] }, false)
      );
      expect(update!.status).toBe("completed");
      expect(update!.content).toEqual([
        { type: "content", content: { type: "text", text: "```\nx\n```" } },
      ]);
    });

    it("forgets the call once ended", () => {
      const mapper = live();
      mapper.start("tc-1", "read", { path: "a.rs" }, "in_progress");
      mapper.end("tc-1", "read", { content: [{ type: "text", text: "1" }] }, false);
      // Without the remembered path the result loses its language hint.
      const [again] = <UpdateFields[]>(
        mapper.end("tc-1", "read", { content: [{ type: "text", text: "1" }] }, false)
      );
      expect(again!.content).toEqual([
        { type: "content", content: { type: "text", text: "```\n1\n```" } },
      ]);
    });
  });
});

/** A parallel workflow snapshot: scout busy with a tool, worker in the given state. */
const snapshot = (scoutTool: string, workerState = "running") => ({
  content: [{ type: "text", text: "(running...)" }],
  details: {
    workflowChildren: {
      version: 1,
      children: [
        {
          childId: "scout",
          state: "running",
          agent: "scout",
          activity: { currentTool: scoutTool },
        },
        { childId: "worker", state: workerState, agent: "worker" },
      ],
    },
  },
});
/** A one-child workflow snapshot; the agent may be missing, as in real snapshots. */
const workflow = (state: string, agent?: string) => ({
  details: {
    workflowChildren: { version: 1, children: [{ childId: "task-1", state, agent }] },
  },
});

const ids = (updates: any[]) => updates.map((u) => `${u.sessionUpdate}:${u.toolCallId}`);

describe("ToolCallMapper with subagent calls", () => {
  const parallelArgs = {
    workflow: "parallel",
    args: {
      tasks: [
        { agent: "scout", task: "Map the repo" },
        { agent: "worker", task: "Fix the bug" },
      ],
    },
  };

  it("opens one card per child below the call's own card", () => {
    const mapper = live();
    mapper.start("tc-1", "subagent", parallelArgs, "in_progress");
    const updates = mapper.progress("tc-1", "subagent", parallelArgs, snapshot("read"));

    expect(ids(updates)).toEqual(["tool_call:tc-1/child-scout", "tool_call:tc-1/child-worker"]);
    expect(updates[0]).toMatchObject({
      kind: "think",
      title: "scout",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "Running `read`" } }],
    });
  });

  it("only resends the cards that changed", () => {
    const mapper = live();
    mapper.start("tc-1", "subagent", parallelArgs, "in_progress");
    mapper.progress("tc-1", "subagent", parallelArgs, snapshot("read"));

    expect(mapper.progress("tc-1", "subagent", parallelArgs, snapshot("read"))).toEqual([]);
    expect(ids(mapper.progress("tc-1", "subagent", parallelArgs, snapshot("bash")))).toEqual([
      "tool_call_update:tc-1/child-scout",
    ]);
  });

  it("settles every child card before the call's own card", () => {
    const mapper = live();
    mapper.start("tc-1", "subagent", parallelArgs, "in_progress");
    mapper.progress("tc-1", "subagent", parallelArgs, snapshot("read"));

    const updates = mapper.end("tc-1", "subagent", snapshot("read", "completed"), true);

    expect(ids(updates)).toEqual([
      "tool_call_update:tc-1/child-scout",
      "tool_call_update:tc-1/child-worker",
      "tool_call_update:tc-1",
    ]);
    // Still running when its call failed: cut short with it.
    expect((updates[0] as any).status).toBe("failed");
    expect((updates[1] as any).status).toBe("completed");
  });

  it("keeps a child's best title when a later snapshot omits its agent", () => {
    const mapper = live();
    mapper.start("tc-1", "subagent", parallelArgs, "in_progress");

    const titles = [
      workflow("running"),
      workflow("running", "delegate"),
      workflow("completed"),
    ].map((snap) => (mapper.progress("tc-1", "subagent", parallelArgs, snap)[0] as any)?.title);

    // Pi-subagents 0.88 sends exactly this sequence for a fast workflow child.
    expect(titles).toEqual(["subagent", "delegate", "delegate"]);
  });

  it("hides the launch records a workflow makes through nested calls", () => {
    const mapper = live();
    const launch = { workflowRunId: "tc-1", key: "scout", agent: "scout" };
    expect(mapper.start("tc-1/1", "subagent_launch", launch, "in_progress")).toEqual([]);
    expect(mapper.progress("tc-1/1", "subagent_launch", launch, {})).toEqual([]);
    expect(mapper.end("tc-1/1", "subagent_launch", { content: [] }, false)).toEqual([]);
  });

  it("shows a single child in the call's own card", () => {
    const args = { agent: "worker", task: "Fix the bug" };
    const mapper = live();
    mapper.start("tc-1", "subagent", args, "in_progress");

    const [progress] = mapper.progress("tc-1", "subagent", args, {
      details: {
        results: [{ index: 0, agent: "worker", task: "Fix the bug" }],
        progress: [
          { index: 0, status: "running", currentTool: "edit", recentTools: [], toolCount: 4 },
        ],
      },
    });
    expect((progress as any).toolCallId).toBe("tc-1");
    expect((progress as any).content[0].content.text).toContain("Running `edit`");

    const finalChild = {
      index: 0,
      agent: "worker",
      exitCode: 0,
      finalOutput: "Fixed in parser.rs",
      progress: { status: "completed", toolCount: 4, durationMs: 3000, recentTools: [] },
    };
    const [end] = mapper.end(
      "tc-1",
      "subagent",
      {
        content: [{ type: "text", text: "Fixed in parser.rs" }],
        details: { results: [finalChild] },
      },
      false,
    );
    // The child's stats, then the output the parent model received, shown once.
    expect((end as any).content.map((block: any) => block.content.text)).toEqual([
      "4 tools · 3s",
      "Fixed in parser.rs",
    ]);
  });
});
