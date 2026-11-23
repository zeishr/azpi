import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpProxyTools } from "../src/client-tool-proxy";
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

  it("replaces each file tool the client can serve", () => {
    expect(create({ fs: { readTextFile: true } })).toEqual(["read"]);
    expect(create({ fs: { writeTextFile: true } })).toEqual(["write"]);
    expect(create({ fs: { readTextFile: true, writeTextFile: true } })).toEqual([
      "read",
      "write",
      "edit",
    ]);
  });

  it("leaves bash to Pi even for a client with terminals", () => {
    // Zed loses the end of a client terminal's output; Pi runs commands itself.
    expect(create({ terminal: true })).toEqual([]);
  });

  it("keeps Pi's own descriptions and parameters", () => {
    const read = tool(mockClient(), "read");
    expect(read.description).toContain("Supports text files and images");
    expect(Object.keys((read.parameters as any).properties)).toEqual(["path", "offset", "limit"]);
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
