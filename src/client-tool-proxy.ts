import type {
  AgentContext,
  ClientCapabilities,
  TerminalOutputResponse,
} from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as _resolve } from "node:path";

const BASH_POLL_INTERVAL = 250;

const readParams = Type.Object({
  path: Type.String({ description: "File path to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start from (1-based)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
});

const writeParams = Type.Object({
  path: Type.String({ description: "File path to write" }),
  content: Type.String({ description: "Content to write" }),
});

const editParams = Type.Object({
  path: Type.String({ description: "File path to edit" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    { description: "Text replacements to apply" },
  ),
});

// Same contract as Pi's native bash tool, so prompts written for Pi still hold.
const bashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

const MS_PER_SECOND = 1000;

/** 1-based indexing for line numbers in Pi/ACP. */
const ONE_BASED_LINE_OFFSET = 1;

export interface AcpProxyToolOptions {
  /** The ACP client context for outbound requests */
  client: AgentContext;
  /** Current session ID */
  sessionId: string;
  /** Client capabilities from initialize */
  capabilities: ClientCapabilities | undefined;
  /** Working directory for resolving relative paths */
  cwd: string;
}

/**
 * Creates proxy ToolDefinitions for ACP client methods that the client
 * advertised capabilities for. Returns an empty array when no capabilities
 * are advertised (all native tools remain active).
 */
export function createAcpProxyTools({
  client,
  sessionId,
  capabilities,
  cwd,
}: AcpProxyToolOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (!capabilities) {
    return tools;
  }

  if (capabilities.fs?.readTextFile) {
    tools.push(createReadProxy(client, sessionId, cwd));
  }

  if (capabilities.fs?.writeTextFile) {
    tools.push(createWriteProxy(client, sessionId, cwd));
  }

  // The "edit" tool requires both read + write capabilities
  if (capabilities.fs?.readTextFile && capabilities.fs?.writeTextFile) {
    tools.push(createEditProxy(client, sessionId, cwd));
  }

  if (capabilities.terminal) {
    tools.push(createBashProxy(client, sessionId, cwd));
  }

  return tools;
}

/** Resolve a potentially-relative path against the cwd. */
function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return path;
  return _resolve(cwd, path);
}

/**
 * Reads through the client so unsaved editor buffers win, and falls back to
 * the disk when the client refuses the path: Zed only serves files of the
 * open project, while Pi may read anywhere.
 */
async function readText(client: AgentContext, sessionId: string, path: string): Promise<string> {
  try {
    const response = await client.request("fs/read_text_file", { sessionId, path });
    return response.content;
  } catch {
    // The local error names the path and the cause, unlike the client's.
    return readFile(path, "utf8");
  }
}

/** Writes through the client so it can track and review the change, with the same fallback as readText. */
async function writeText(
  client: AgentContext,
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  try {
    await client.request("fs/write_text_file", { sessionId, path, content });
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/** Apply offset/limit/truncation to raw file content, matching Pi's semantics. */
function applyOffsetLimit(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  let resultLines = lines;

  if (offset && offset > ONE_BASED_LINE_OFFSET) {
    resultLines = resultLines.slice(offset - ONE_BASED_LINE_OFFSET);
  }

  if (limit !== undefined && limit >= 0) {
    resultLines = resultLines.slice(0, limit);
  }

  return resultLines.join("\n");
}

function createReadProxy(client: AgentContext, sessionId: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "read",
    label: "Read File",
    description: "Read the contents of a text file at the given path. Lines are 1-indexed.",
    parameters: readParams,
    execute: async (_toolCallId, params) => {
      const absolutePath = resolvePath(cwd, params.path);
      const content = applyOffsetLimit(
        await readText(client, sessionId, absolutePath),
        params.offset,
        params.limit,
      );

      return {
        content: [{ type: "text" as const, text: content }],
        details: {},
      };
    },
  });
}

function createWriteProxy(client: AgentContext, sessionId: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "write",
    label: "Write File",
    description: "Write the contents to a text file at the given path.",
    parameters: writeParams,
    execute: async (_toolCallId, params) => {
      const absolutePath = resolvePath(cwd, params.path);
      await writeText(client, sessionId, absolutePath, params.content);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully wrote ${params.content.length} bytes to ${absolutePath}`,
          },
        ],
        details: {},
      };
    },
  });
}

function createEditProxy(client: AgentContext, sessionId: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "edit",
    label: "Edit File",
    description: "Apply exact-text replacements to a file.",
    parameters: editParams,
    execute: async (_toolCallId, params) => {
      const absolutePath = resolvePath(cwd, params.path);

      let content = await readText(client, sessionId, absolutePath);

      for (const edit of params.edits) {
        const index = content.indexOf(edit.oldText);
        if (index === -1) {
          throw new Error(
            `Edit failed: could not find exact text to replace in ${absolutePath}. ` +
              `The text may have already been changed or the oldText is incorrect.`,
          );
        }
        content =
          content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
      }

      await writeText(client, sessionId, absolutePath, content);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully applied ${params.edits.length} edit(s) to ${absolutePath}`,
          },
        ],
        details: {},
      };
    },
  });
}

function createBashProxy(client: AgentContext, sessionId: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "Run a shell command. Returns output and exit code.",
    parameters: bashParams,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { terminalId } = await client.request("terminal/create", {
        sessionId,
        command: params.command,
        cwd,
      });
      const terminal = { sessionId, terminalId };
      const release = () => client.request("terminal/release", terminal);
      const timeoutMs = params.timeout === undefined ? undefined : params.timeout * MS_PER_SECOND;

      try {
        // Embedded right away, as ACP only accepts it before terminal/release.
        // Carrying terminalId in details tells the event bridge to leave this
        // content alone instead of replacing it with plain text output.
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            content: [{ type: "terminal", terminalId }],
          },
        });

        let accumulated = "";
        const startTime = Date.now();

        /* eslint-disable no-await-in-loop */
        while (true) {
          if (signal?.aborted) {
            await client.request("terminal/kill", terminal);
            await release();
            return {
              content: [{ type: "text" as const, text: accumulated || "Command cancelled" }],
              details: { cancelled: true, truncated: false, terminalId },
            };
          }

          if (timeoutMs && Date.now() - startTime > timeoutMs) {
            await client.request("terminal/kill", terminal);

            const finalOutput: TerminalOutputResponse = await client.request(
              "terminal/output",
              terminal,
            );
            await release();
            return {
              content: [
                {
                  type: "text" as const,
                  text: appendStatus(
                    finalOutput.output,
                    `Command timed out after ${params.timeout} seconds`,
                  ),
                },
              ],
              isError: true,
              details: {
                exitCode: null,
                timedOut: true,
                truncated: finalOutput.truncated,
                terminalId,
              },
            };
          }

          const output: TerminalOutputResponse = await client.request("terminal/output", terminal);
          if (output.output !== accumulated) {
            accumulated = output.output;

            onUpdate?.({
              content: [{ type: "text" as const, text: accumulated }],
              details: { truncated: output.truncated, terminalId },
            });
          }

          if (output.exitStatus) {
            const exitCode = output.exitStatus.exitCode ?? -1;

            await release();

            // Like Pi's native bash: a failing command is an error result, not a success.
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    exitCode === 0
                      ? accumulated
                      : appendStatus(accumulated, `Command exited with code ${exitCode}`),
                },
              ],
              isError: exitCode !== 0,
              details: {
                exitCode,
                truncated: output.truncated,
                terminalId,
              },
            };
          }

          await sleep(BASH_POLL_INTERVAL, signal);
        }
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        try {
          await release();
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
  });
}

/** Appends a status line the way Pi's native bash does. */
function appendStatus(output: string, status: string): string {
  return output ? `${output}\n\n${status}` : status;
}

/** Sleep for ms, aborting early if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
