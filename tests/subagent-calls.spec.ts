import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentCalls } from "../src/subagent-calls";

const context = { cwd: "/parent", live: true };
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const toolCall = (id: string, name: string, args: object) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const toolResult = (id: string) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: "x", content: [], isError: false },
});

/** A child session file that already holds its header and one tool call. */
function childSession(): string {
  const path = join(mkdtempSync(join(tmpdir(), "azpi-")), "session.jsonl");
  writeFileSync(
    path,
    line({ type: "session", cwd: "/child" }) +
      line(toolCall("c1", "read", { path: "/child/a.ts" })),
  );
  return path;
}

const textOf = (update: any) => update.content.map((block: any) => block.content.text).join("\n");

/** A single child's progress snapshot, naming its session file as pi-subagents 0.90 does. */
const progress = (sessionFile: string) => ({
  results: [{ index: 0, agent: "worker" }],
  progress: [{ index: 0, status: "running", toolCount: 1, recentTools: [], sessionFile }],
});

describe("SubagentCalls with a single child", () => {
  const args = { agent: "worker", task: "Fix it" };

  it("shows the child's transcript in the call's own card", () => {
    const calls = new SubagentCalls(context);
    calls.start("tc-1", args);

    const [update] = calls.progress("tc-1", progress(childSession())) as any[];

    expect(update.toolCallId).toBe("tc-1");
    // Titled from the child's own working directory.
    expect(textOf(update)).toBe("1 tool\n\n- Read a.ts …");
  });

  it("follows the transcript between snapshots", () => {
    const calls = new SubagentCalls(context);
    const file = childSession();
    calls.start("tc-1", args);
    calls.progress("tc-1", progress(file));

    expect(calls.poll()).toEqual([]);
    appendFileSync(
      file,
      line(toolResult("c1")) + line(toolCall("c2", "bash", { command: "make" })),
    );
    const [update] = calls.poll() as any[];

    expect(textOf(update)).toBe("1 tool\n\n- Read a.ts\n- Run `make` …");
    expect(calls.poll()).toEqual([]);
  });

  it("ends with the child's stats and transcript ahead of the result", () => {
    const calls = new SubagentCalls(context);
    const file = childSession();
    calls.start("tc-1", args);
    calls.progress("tc-1", progress(file));
    appendFileSync(file, line(toolResult("c1")));

    const { updates, ownContent } = calls.end("tc-1", args, {
      content: [{ type: "text", text: "Fixed." }],
      details: {
        results: [{ index: 0, agent: "worker", exitCode: 0, sessionFile: file }],
      },
      isError: false,
    });

    expect(updates).toEqual([]);
    expect(textOf({ content: ownContent })).toBe("- Read a.ts");
    expect(calls.running).toBe(false);
  });

  it("reads a replayed call's transcript from its final result", () => {
    const calls = new SubagentCalls({ cwd: "/parent", live: false });
    const { ownContent } = calls.end("tc-1", args, {
      content: [],
      details: {
        results: [{ index: 0, agent: "worker", exitCode: 0, sessionFile: childSession() }],
      },
      isError: false,
    });
    expect(textOf({ content: ownContent })).toBe("- Read a.ts …");
  });
});

describe("SubagentCalls with a workflow", () => {
  const args = { workflow: "parallel", args: { tasks: [{ agent: "a" }, { agent: "b" }] } };

  it("gives each child card its own transcript, refreshed by polling", () => {
    const calls = new SubagentCalls(context);
    const fileA = childSession();
    calls.start("tc-1", args);

    const opened = calls.progress("tc-1", {
      workflowChildren: {
        version: 1,
        children: [
          { childId: "a", state: "running", agent: "a", sessionFile: fileA },
          { childId: "b", state: "pending", agent: "b" },
        ],
      },
    }) as any[];

    expect(opened.map((update) => update.toolCallId)).toEqual(["tc-1/child-a", "tc-1/child-b"]);
    expect(textOf(opened[0])).toBe("- Read a.ts …");

    appendFileSync(fileA, line(toolResult("c1")));
    const polled = calls.poll() as any[];
    expect(polled.map((update) => update.toolCallId)).toEqual(["tc-1/child-a"]);
    expect(textOf(polled[0])).toBe("- Read a.ts");
  });

  it("leaves a finished child's closing words to its output", () => {
    const calls = new SubagentCalls(context);
    const file = childSession();
    appendFileSync(
      file,
      line(toolResult("c1")) +
        line({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "DONE" }] },
        }),
    );
    calls.start("tc-1", args);

    const { updates } = calls.end("tc-1", args, {
      content: [],
      details: {
        workflowChildren: {
          version: 1,
          children: [{ childId: "a", state: "completed", agent: "a", sessionFile: file }],
        },
        results: [{ index: 0, workflowKey: "a", finalOutput: "DONE" }],
      },
      isError: false,
    });

    // The transcript stops at the last step; the output follows once.
    expect(textOf(updates[0])).toBe("- Read a.ts\n\nDONE");
  });

  it("reports nothing to poll once its calls ended", () => {
    const calls = new SubagentCalls(context);
    calls.start("tc-1", args);
    expect(calls.running).toBe(true);
    calls.end("tc-1", args, { content: [], details: {}, isError: false });
    expect(calls.running).toBe(false);
    expect(calls.poll()).toEqual([]);
  });
});
