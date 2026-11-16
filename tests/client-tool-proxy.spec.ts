import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAcpProxyTools,
  exitCodeOf,
  outputForwarder,
  piVariables,
} from "../src/client-tool-proxy";
import { mockClient } from "./mock-client";

const SESSION_ID = "test-session-id";

/** Stands in for Zed refusing a path outside its project. */
const refuse = async () => {
  throw new Error("Resource not found");
};

/** The slice of Pi's tool context the built-in tools read. */
const toolContext = {
  cwd: "/",
  model: { provider: "anthropic", id: "claude", input: ["text", "image"] },
  thinkingLevel: "high",
  sessionManager: { getSessionId: () => "pi-session", getSessionFile: () => "/tmp/s.jsonl" },
} as any;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "azpi-"));
}

function tool(conn: ReturnType<typeof mockClient>, name: string, cwd = "/") {
  const tools = createAcpProxyTools({
    client: conn,
    sessionId: SESSION_ID,
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    cwd,
  });
  return tools.find((t) => t.name === name)!;
}

function run(conn: ReturnType<typeof mockClient>, name: string, params: object, cwd = "/") {
  // Pi's tools resolve paths against the context's cwd, the session's in practice.
  const context = { ...toolContext, cwd };
  return tool(conn, name, cwd).execute("tc-1", params, undefined, undefined, context);
}

const textOf = (result: { content: any[] }) => result.content[0]?.text as string;

describe("createAcpProxyTools", () => {
  const create = (capabilities: object) =>
    createAcpProxyTools({
      client: mockClient(),
      sessionId: SESSION_ID,
      capabilities,
      cwd: "/",
    }).map((t) => t.name);

  it("keeps Pi's local tools when the client advertises nothing", () => {
    expect(create({})).toEqual([]);
  });

  it("replaces each tool the client can serve", () => {
    expect(create({ fs: { readTextFile: true } })).toEqual(["read"]);
    expect(create({ fs: { writeTextFile: true } })).toEqual(["write"]);
    expect(create({ terminal: true })).toEqual(["bash"]);
    expect(create({ fs: { readTextFile: true, writeTextFile: true }, terminal: true })).toEqual([
      "read",
      "write",
      "edit",
      "bash",
    ]);
  });

  it("keeps Pi's own descriptions and parameters", () => {
    const bash = tool(mockClient(), "bash");
    expect(bash.description).toContain("timeout in seconds");
    expect(Object.keys((bash.parameters as any).properties)).toEqual(["command", "timeout"]);
  });
});

describe("read", () => {
  it("reads through the client, which sees unsaved buffers", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "on disk");
    const conn = mockClient({ "fs/read_text_file": async () => ({ content: "in the editor" }) });

    const result = await run(conn, "read", { path: "a.txt" }, dir);

    expect(textOf(result)).toBe("in the editor");
    expect(conn.method("fs/read_text_file")).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      path: join(dir, "a.txt"),
    });
  });

  it("falls back to the disk when the client refuses the path", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "a\nb\nc");
    const conn = mockClient({ "fs/read_text_file": refuse });

    expect(textOf(await run(conn, "read", { path: "a.txt", offset: 2 }, dir))).toBe("b\nc");
  });

  it("reads images from the disk, the client serving text only", async () => {
    const dir = tempDir();
    // A complete 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(dir, "pixel.png"), png);
    const conn = mockClient();

    const result = await run(conn, "read", { path: "pixel.png" }, dir);

    expect(conn.method("fs/read_text_file")).not.toHaveBeenCalled();
    expect(result.content.some((block: any) => block.type === "image")).toBe(true);
  });

  it("reports a missing file with its path", async () => {
    await expect(
      run(mockClient(), "read", { path: "/nonexistent/azpi-missing.txt" }),
    ).rejects.toThrow("/nonexistent/azpi-missing.txt");
  });
});

describe("write", () => {
  it("writes through the client, so it can review the change", async () => {
    const dir = tempDir();
    const conn = mockClient();

    await run(conn, "write", { path: "new.txt", content: "hello" }, dir);

    expect(conn.method("fs/write_text_file")).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      path: join(dir, "new.txt"),
      content: "hello",
    });
  });

  it("falls back to the disk, creating missing directories", async () => {
    const dir = tempDir();
    const conn = mockClient({ "fs/write_text_file": refuse });

    await run(conn, "write", { path: "nested/new.txt", content: "hello" }, dir);

    expect(readFileSync(join(dir, "nested/new.txt"), "utf8")).toBe("hello");
  });
});

describe("edit", () => {
  it("edits the client's version of the file and writes it back through the client", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "stale disk copy");
    const conn = mockClient({ "fs/read_text_file": async () => ({ content: "hello world\n" }) });

    const result = await run(
      conn,
      "edit",
      { path: "a.txt", edits: [{ oldText: "world", newText: "zed" }] },
      dir,
    );

    expect(conn.method("fs/write_text_file")).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      path: join(dir, "a.txt"),
      content: "hello zed\n",
    });
    // Pi's own edit details, which the event bridge uses to locate the change.
    expect(result.details).toMatchObject({ firstChangedLine: 1 });
  });

  it("edits on disk when the client refuses the path", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "hello world");
    const conn = mockClient({ "fs/read_text_file": refuse, "fs/write_text_file": refuse });

    await run(conn, "edit", { path: "a.txt", edits: [{ oldText: "world", newText: "zed" }] }, dir);

    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello zed");
  });
});

/** terminal/output answers: an exited command, or one still running. */
const exited = (output: string, exitCode: number) => ({
  output,
  truncated: false,
  exitStatus: { exitCode, signal: null },
});
const running = (output: string) => ({ output, truncated: false });

describe("bash", () => {
  /** A client whose terminal/output answers come from `outputs`, the last one repeating. */
  function terminalClient(...outputs: object[]) {
    const output = mock(async () => (outputs.length > 1 ? outputs.shift() : outputs[0]));
    return mockClient({
      "terminal/create": async () => ({ terminalId: "term-1" }),
      "terminal/output": output,
    });
  }

  it("runs the command in a client terminal and returns its output", async () => {
    const conn = terminalClient(running("hel"), exited("hello\n", 0));

    const result = await run(conn, "bash", { command: "echo hello" });

    expect(conn.method("terminal/create")).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, command: "echo hello", cwd: "/" }),
    );
    expect(textOf(result)).toBe("hello\n");
    expect(result.isError).toBeFalsy();
    expect(conn.method("terminal/release")).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      terminalId: "term-1",
    });
  });

  it("embeds the terminal in the tool call before releasing it", async () => {
    const conn = terminalClient(exited("ok", 0));

    const result = await run(conn, "bash", { command: "true" });

    expect(conn.sessionUpdate).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        content: [{ type: "terminal", terminalId: "term-1" }],
      },
    });
    // ACP ignores a terminal added to a tool call after terminal/release.
    const embedOrder = conn.sessionUpdate.mock.invocationCallOrder[0]!;
    const releaseOrder = conn.method("terminal/release").mock.invocationCallOrder[0]!;
    expect(embedOrder).toBeLessThan(releaseOrder);
    expect(result.details).toMatchObject({ terminalId: "term-1" });
  });

  it("tags partial results with the terminal, so the card keeps showing it", async () => {
    const conn = terminalClient(running("a"), exited("ab", 0));
    const onUpdate = mock();

    await tool(conn, "bash").execute("tc-1", { command: "x" }, undefined, onUpdate, toolContext);

    const partials = onUpdate.mock.calls.map((call: any[]) => call[0]);
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.at(-1).details).toMatchObject({ terminalId: "term-1" });
  });

  it("reports a non-zero exit code as an error, as Pi does", async () => {
    const conn = terminalClient(exited("boom", 2));

    const result = await run(conn, "bash", { command: "false" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("boom\n\nCommand exited with code 2");
  });

  it("kills and releases the terminal when aborted", async () => {
    const conn = terminalClient(running("partial"));
    const controller = new AbortController();

    const promise = tool(conn, "bash").execute(
      "tc-1",
      { command: "sleep 100" },
      controller.signal,
      undefined,
      toolContext,
    );
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toThrow("Command aborted");
    expect(conn.method("terminal/kill")).toHaveBeenCalled();
    expect(conn.method("terminal/release")).toHaveBeenCalled();
  });

  it("kills the terminal once the timeout, in seconds, runs out", async () => {
    const conn = terminalClient(running("still going"));

    await expect(run(conn, "bash", { command: "sleep 100", timeout: 0.3 })).rejects.toThrow(
      "Command timed out after 0.3 seconds",
    );
    expect(conn.method("terminal/kill")).toHaveBeenCalled();
    expect(conn.method("terminal/release")).toHaveBeenCalled();
  });

  it("passes the session's PI_* variables to the command", async () => {
    const conn = terminalClient(exited("", 0));

    await run(conn, "bash", { command: "env" });

    const env = (conn.method("terminal/create").mock.calls[0]![0] as any).env;
    expect(env).toContainEqual({ name: "PI_SESSION_ID", value: "pi-session" });
    expect(env.every((variable: any) => variable.name.startsWith("PI_"))).toBe(true);
  });

  it("releases the terminal when the client fails mid-command", async () => {
    const conn = mockClient({
      "terminal/create": async () => ({ terminalId: "term-1" }),
      "terminal/output": async () => {
        throw new Error("connection lost");
      },
    });

    await expect(run(conn, "bash", { command: "echo hello" })).rejects.toThrow("connection lost");
    expect(conn.method("terminal/release")).toHaveBeenCalled();
  });
});

describe("outputForwarder", () => {
  it("forwards only what each snapshot adds", () => {
    const chunks: string[] = [];
    const forward = outputForwarder((data) => chunks.push(data.toString()));
    forward("a");
    forward("ab");
    forward("ab");
    forward("abc");
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("skips a snapshot whose start the client truncated, then resumes", () => {
    const chunks: string[] = [];
    const forward = outputForwarder((data) => chunks.push(data.toString()));
    forward("abc");
    forward("cde");
    forward("cdef");
    expect(chunks).toEqual(["abc", "f"]);
  });
});

describe("exitCodeOf", () => {
  it("keeps a real exit code and maps a signal the way shells do", () => {
    expect(exitCodeOf({ exitCode: 3 })).toBe(3);
    expect(exitCodeOf({ exitCode: null, signal: "SIGKILL" })).toBe(137);
    expect(exitCodeOf({ exitCode: null, signal: null })).toBeNull();
  });
});

describe("piVariables", () => {
  it("keeps only the PI_* variables", () => {
    expect(piVariables({ PATH: "/bin", PI_MODEL: "claude", HOME: "/root" })).toEqual([
      { name: "PI_MODEL", value: "claude" },
    ]);
    expect(piVariables(undefined)).toEqual([]);
  });
});
