import { describe, expect, it } from "bun:test";
import {
  presentResultLocations,
  presentToolCall,
  presentToolProgress,
  presentToolResult,
} from "../src/tool-presentation";
import type { PresentationContext, ToolOutcome } from "../src/tool-presentation";

const ctx: PresentationContext = { cwd: "/repo", live: true };
const replay: PresentationContext = { cwd: "/repo", live: false };
const text = (value: string): ToolOutcome => ({
  content: [{ type: "text", text: value }],
  isError: false,
});
const textBlock = (value: string) => ({
  type: "content" as const,
  content: { type: "text" as const, text: value },
});

describe("presentToolCall", () => {
  it("titles a read with a path relative to the working directory and its line range", () => {
    const view = presentToolCall("read", { path: "/repo/src/a.ts", offset: 10, limit: 5 }, ctx);
    expect(view.title).toBe("Read src/a.ts (L10-14)");
    expect(view.kind).toBe("read");
    expect(view.locations).toEqual([{ path: "/repo/src/a.ts", line: 10 }]);
  });

  it("keeps absolute paths outside the working directory", () => {
    expect(presentToolCall("read", { path: "/etc/hosts" }, ctx).title).toBe("Read /etc/hosts");
  });

  it("accepts line numbers sent as strings, like Pi does", () => {
    expect(presentToolCall("read", { path: "a.ts", offset: "3" }, ctx).title).toBe(
      "Read a.ts (from L3)",
    );
  });

  it("previews an edit as one diff per replacement", () => {
    const view = presentToolCall(
      "edit",
      {
        path: "src/a.ts",
        edits: [
          { oldText: "one", newText: "1" },
          { oldText: "two", newText: "2" },
        ],
      },
      ctx,
    );
    expect(view.kind).toBe("edit");
    expect(view.title).toBe("Edit src/a.ts");
    expect(view.content).toEqual([
      { type: "diff", path: "/repo/src/a.ts", oldText: "one", newText: "1" },
      { type: "diff", path: "/repo/src/a.ts", oldText: "two", newText: "2" },
    ]);
  });

  it("previews a legacy single-replacement edit", () => {
    const view = presentToolCall("edit", { path: "a.ts", oldText: "x", newText: "y" }, ctx);
    expect(view.content).toEqual([
      { type: "diff", path: "/repo/a.ts", oldText: "x", newText: "y" },
    ]);
  });

  it("previews a write as a new file", () => {
    const view = presentToolCall("write", { path: "notes.md", content: "# hi" }, ctx);
    expect(view.content).toEqual([
      { type: "diff", path: "/repo/notes.md", oldText: null, newText: "# hi" },
    ]);
  });

  it("titles a bash call with its first command line as code", () => {
    const view = presentToolCall("bash", { command: "cd src\nmake test" }, ctx);
    expect(view.title).toBe("`cd src …`");
    expect(view.kind).toBe("execute");
  });

  it("widens the code span of a command that contains backticks", () => {
    // Markdown needs spaces inside the fence when the content ends with a backtick.
    expect(presentToolCall("bash", { command: "echo `date`" }, ctx).title).toBe(
      "`` echo `date` ``",
    );
    expect(presentToolCall("bash", { command: "a `b` c" }, ctx).title).toBe("``a `b` c``");
  });

  it("titles searches", () => {
    expect(presentToolCall("grep", { pattern: "TODO", path: "src", glob: "*.ts" }, ctx).title).toBe(
      "Grep `TODO` in src (*.ts)",
    );
    expect(presentToolCall("find", { pattern: "*.md" }, ctx).title).toBe("Find `*.md` in .");
    expect(presentToolCall("ls", {}, ctx).title).toBe("List .");
    expect(presentToolCall("web_search", { queries: ["acp", "zed"] }, ctx).title).toBe(
      "Web search: acp | zed",
    );
    expect(presentToolCall("fetch_content", { url: "https://x.dev" }, ctx).kind).toBe("fetch");
  });

  it("summarizes an unknown tool by its most telling argument and shows the arguments", () => {
    const view = presentToolCall("deploy", { target: "prod", name: "api" }, ctx);
    expect(view.title).toBe("deploy: api");
    expect(view.kind).toBe("other");
    expect(view.content).toEqual([
      textBlock('```json\n{\n  "target": "prod",\n  "name": "api"\n}\n```'),
    ]);
  });

  it("falls back to the bare name for an unknown tool without arguments", () => {
    const view = presentToolCall("refresh", undefined, ctx);
    expect(view.title).toBe("refresh");
    expect(view.content).toEqual([]);
  });

  it("truncates long titles", () => {
    const title = presentToolCall("bash", { command: "x".repeat(300) }, ctx).title;
    expect(title.length).toBe(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("presentToolProgress", () => {
  it("streams native bash output as console code", () => {
    expect(presentToolProgress("bash", {}, text("building..."), ctx)).toEqual([
      textBlock("```console\nbuilding...\n```"),
    ]);
  });

  it("leaves a terminal-backed bash card to its terminal", () => {
    const partial = { ...text("..."), details: { terminalId: "t1" } };
    expect(presentToolProgress("bash", {}, partial, ctx)).toBeUndefined();
  });
});

describe("presentToolResult", () => {
  it("shows a read as code highlighted after the file extension", () => {
    expect(presentToolResult("read", { path: "a.py" }, text("print(1)\n"), ctx)).toEqual([
      textBlock("```py\nprint(1)\n```"),
    ]);
  });

  it("uses a longer fence when the content holds one", () => {
    expect(presentToolResult("read", { path: "a.md" }, text("```js\nx\n```"), ctx)).toEqual([
      textBlock("````md\n```js\nx\n```\n````"),
    ]);
  });

  it("keeps images of a result", () => {
    const outcome: ToolOutcome = {
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      isError: false,
    };
    expect(presentToolResult("read", { path: "a.png" }, outcome, ctx)).toEqual([
      { type: "content", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
    ]);
  });

  it("keeps the preview diff of a successful edit", () => {
    expect(presentToolResult("edit", {}, text("Successfully replaced"), ctx)).toBeUndefined();
  });

  it("replaces the preview of a failed edit with the error", () => {
    const outcome = { ...text("oldText not found"), isError: true };
    expect(presentToolResult("edit", {}, outcome, ctx)).toEqual([textBlock("oldText not found")]);
  });

  it("keeps a terminal-backed bash card on failure: the client shows the exit status", () => {
    const outcome = {
      ...text("boom\n\nCommand exited with code 3"),
      details: { terminalId: "t1" },
      isError: true,
    };
    expect(presentToolResult("bash", {}, outcome, ctx)).toBeUndefined();
  });

  it("shows the error of a failed read, grep, find or ls", () => {
    const outcome = { ...text("ENOENT: /x"), isError: true };
    for (const name of ["read", "grep", "find", "ls"]) {
      expect(presentToolResult(name, { path: "/x" }, outcome, ctx)).toEqual([
        textBlock("ENOENT: /x"),
      ]);
    }
  });

  it("surfaces the error of a tool whose presenter shows nothing on failure", () => {
    const outcome = { ...text("ENOENT"), isError: true };
    expect(presentToolResult("read", { path: "a.ts" }, outcome, ctx)).toEqual([
      textBlock("ENOENT"),
    ]);
  });

  it("shows a terminal-backed bash result as text on replay, its terminal being gone", () => {
    const outcome = { ...text("ok"), details: { terminalId: "t1" } };
    expect(presentToolResult("bash", {}, outcome, ctx)).toBeUndefined();
    expect(presentToolResult("bash", {}, outcome, replay)).toEqual([
      textBlock("```console\nok\n```"),
    ]);
  });

  it("shows every text block of a generic result", () => {
    const outcome: ToolOutcome = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      isError: false,
    };
    expect(presentToolResult("custom", {}, outcome, ctx)).toEqual([textBlock("first\nsecond")]);
  });

  it("serializes a result that is neither text nor content blocks", () => {
    expect(presentToolResult("custom", {}, { content: { code: 0 }, isError: false }, ctx)).toEqual([
      textBlock('{\n  "code": 0\n}'),
    ]);
  });
});

describe("presentResultLocations", () => {
  it("points an edit at the first line it changed", () => {
    const outcome = { ...text("ok"), details: { firstChangedLine: 42 } };
    expect(presentResultLocations("edit", { path: "a.ts" }, outcome, ctx)).toEqual([
      { path: "/repo/a.ts", line: 42 },
    ]);
  });

  it("leaves other tools' locations alone", () => {
    expect(presentResultLocations("read", { path: "a.ts" }, text("x"), ctx)).toBeUndefined();
  });
});
