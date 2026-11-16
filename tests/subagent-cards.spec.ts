import { describe, expect, it } from "bun:test";
import {
  childCard,
  runsSeveralChildren,
  subagentChildren,
  subagentTitle,
} from "../src/subagent-cards";
import type { SubagentChild } from "../src/subagent-cards";

const cardText = (row: SubagentChild, options: Parameters<typeof childCard>[1]) =>
  ((childCard(row, options).content[0] as any)?.content.text ?? "") as string;

function makeChild(overrides: Partial<SubagentChild> = {}): SubagentChild {
  return {
    key: "0",
    agent: "worker",
    status: "running",
    recentTools: [],
    ...overrides,
  };
}

describe("runsSeveralChildren", () => {
  it("tells single-agent calls from fan-outs", () => {
    expect(runsSeveralChildren({ agent: "worker", task: "x" })).toBe(false);
    expect(runsSeveralChildren({ tasks: [] })).toBe(true);
    expect(runsSeveralChildren({ chain: [] })).toBe(true);
    expect(runsSeveralChildren({ workflow: "parallel" })).toBe(true);
    expect(runsSeveralChildren(undefined)).toBe(false);
  });
});

describe("subagentTitle", () => {
  it("names the agent and the first line of its task", () => {
    expect(subagentTitle({ agent: "scout", task: "Map the repo\nthen report" })).toBe(
      "scout: Map the repo …",
    );
  });

  it("names parallel children, chains and workflows", () => {
    expect(
      subagentTitle({
        tasks: [
          { agent: "a", task: "x" },
          { agent: "b", task: "y" },
        ],
      }),
    ).toBe("Subagents in parallel: a, b");
    expect(
      subagentTitle({
        chain: [{ agent: "scout" }, { parallel: [{ agent: "w1" }, { agent: "w2" }] }],
      }),
    ).toBe("Subagent chain: scout → (w1 + w2)");
    expect(subagentTitle({ workflow: "review", async: true })).toBe(
      "Workflow: review (background)",
    );
    expect(subagentTitle({ workflow: true })).toBe("Workflow: inline script");
  });

  it("names the steps of the built-in parallel and chain workflows", () => {
    expect(
      subagentTitle({
        workflow: "parallel",
        args: {
          tasks: [
            { agent: "a", task: "x" },
            { agent: "b", task: "y" },
          ],
        },
      }),
    ).toBe("Subagents in parallel: a, b");
    expect(
      subagentTitle({ workflow: "chain", args: { chain: [{ agent: "a" }, { agent: "b" }] } }),
    ).toBe("Subagent chain: a → b");
  });

  it("names management actions", () => {
    expect(subagentTitle({ action: "status", id: "run-1" })).toBe("subagent status run-1");
  });
});

describe("subagentChildren", () => {
  it("merges result and progress rows by index, in index order", () => {
    const children = subagentChildren({
      results: [
        { index: 1, agent: "b", task: "y", exitCode: 0, finalOutput: "done b" },
        { index: 0, agent: "a", task: "x", sessionName: "a: x" },
      ],
      progress: [
        {
          index: 0,
          agent: "a",
          status: "running",
          currentTool: "bash",
          currentToolArgs: "make",
          recentTools: [{ tool: "read", args: "src/a.ts", endMs: 1 }],
          toolCount: 3,
          tokens: 12000,
          durationMs: 5000,
          model: "claude-opus",
        },
      ],
    });

    expect(children.map((c) => c.key)).toEqual(["0", "1"]);
    expect(children[0]).toMatchObject({
      sessionName: "a: x",
      status: "running",
      currentTool: "bash",
      recentTools: [{ tool: "read", args: "src/a.ts" }],
      model: "claude-opus",
    });
    // Without a progress row, the exit code decides.
    expect(children[1]).toMatchObject({ status: "completed", finalOutput: "done b" });
  });

  it("reads the counters a final result row keeps in progressSummary", () => {
    const [only] = subagentChildren({
      results: [
        {
          index: 0,
          agent: "delegate",
          exitCode: 0,
          progressSummary: { toolCount: 2, tokens: 621, durationMs: 10890 },
        },
      ],
    });
    expect(only).toMatchObject({
      status: "completed",
      toolCount: 2,
      tokens: 621,
      durationMs: 10890,
    });
  });

  it("reads the progress nested in a result row", () => {
    const [only] = subagentChildren({
      results: [{ index: 0, agent: "a", progress: { status: "failed", error: "quota" } }],
    });
    expect(only).toMatchObject({ status: "failed", error: "quota" });
  });

  it("reads workflow children from the live summary, keyed by childId", () => {
    const children = subagentChildren({
      workflowChildren: {
        version: 1,
        children: [
          {
            childId: "task-1",
            state: "running",
            agent: "delegate",
            sessionName: "delegate: Run echo",
            model: "opus",
            activity: { currentTool: "bash", toolCount: 1, tokens: 900, durationMs: 2000 },
          },
          { childId: "task-2", state: "completed", agent: "delegate" },
          { childId: "task-3", state: "stopped", agent: "delegate" },
        ],
      },
      // Each workflow child is a run of its own: every row has index 0.
      results: [
        { index: 0, workflowKey: "task-2", finalOutput: "BETA", task: "Reply BETA" },
        { index: 0, workflowKey: "task-3", error: "stopped by user" },
      ],
    });

    expect(children.map((c) => [c.key, c.status])).toEqual([
      ["task-1", "running"],
      ["task-2", "completed"],
      ["task-3", "failed"],
    ]);
    expect(children[0]).toMatchObject({
      sessionName: "delegate: Run echo",
      currentTool: "bash",
      toolCount: 1,
      tokens: 900,
    });
    expect(children[1]).toMatchObject({ finalOutput: "BETA" });
    expect(children[2]).toMatchObject({ error: "stopped by user" });
  });

  it("ignores a workflow summary of an unknown version", () => {
    const children = subagentChildren({
      workflowChildren: { version: 2, children: [{ childId: "x", state: "running" }] },
    });
    expect(children).toEqual([]);
  });

  it("ignores rows without an index and details of other shapes", () => {
    expect(subagentChildren({ results: [{ agent: "a" }] })).toEqual([]);
    expect(subagentChildren("text")).toEqual([]);
    expect(subagentChildren(undefined)).toEqual([]);
  });
});

describe("childCard", () => {
  it("shows a running child's stats and activity", () => {
    const text = cardText(
      makeChild({
        model: "opus",
        thinking: "high",
        toolCount: 2,
        tokens: 1500,
        durationMs: 9000,
        currentTool: "bash",
        currentToolArgs: "cargo test",
        recentTools: [{ tool: "read", args: "src/lib.rs" }],
        progressText: "tests compile",
      }),
      { includeOutput: true },
    );
    expect(text).toBe(
      [
        "`opus` · thinking high · 2 tools · 1.5k tokens",
        "Running `bash` cargo test",
        "- `read` src/lib.rs",
        "Progress: tests compile",
      ].join("\n\n"),
    );
    expect(childCard(makeChild(), { includeOutput: true }).status).toBe("in_progress");
  });

  it("shows a finished child's stats, duration and output", () => {
    const card = childCard(
      makeChild({
        status: "completed",
        toolCount: 1,
        durationMs: 75000,
        finalOutput: "All green.",
      }),
      { includeOutput: true },
    );
    expect(card.status).toBe("completed");
    expect((card.content[0] as any).content.text).toBe("1 tool · 1m 15s\n\nAll green.");
  });

  it("leaves the output out when the parent card already shows it", () => {
    const text = cardText(makeChild({ status: "completed", finalOutput: "All green." }), {
      includeOutput: false,
    });
    expect(text).not.toContain("All green.");
  });

  it("gives a child cut short the final status of its call", () => {
    expect(
      childCard(makeChild({ status: "running" }), { callStatus: "failed", includeOutput: true })
        .status,
    ).toBe("failed");
  });

  it("marks a detached child done and says it continues", () => {
    const card = childCard(makeChild({ status: "detached" }), { includeOutput: true });
    expect(card.status).toBe("completed");
    expect((card.content[0] as any).content.text).toContain("Continues in the background.");
  });

  it("has no title while nothing names the child", () => {
    expect(
      childCard(makeChild({ agent: undefined }), { includeOutput: true }).title,
    ).toBeUndefined();
  });

  it("titles a card by its session name, else by its agent", () => {
    // Pi-subagents redacts tasks in its rows; the session name holds an excerpt.
    expect(
      childCard(makeChild({ sessionName: "worker: Fix…" }), { includeOutput: true }).title,
    ).toBe("worker: Fix…");
    expect(childCard(makeChild(), { includeOutput: true }).title).toBe("worker");
  });
});

describe("childCard without anything to show", () => {
  it("has no content rather than an empty text block", () => {
    const bare: SubagentChild = { key: "0", status: "completed", recentTools: [] };
    expect(childCard(bare, { includeOutput: true }).content).toEqual([]);
  });
});
