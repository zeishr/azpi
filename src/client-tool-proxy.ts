import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import type {
  EditOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Pi's own read, write and edit tools, with their file access routed through
 * the ACP client.
 *
 * Going through the client lets it show unsaved buffers to the agent and
 * track and review the agent's edits. Pi keeps its schemas, prompts,
 * truncation, image handling and fuzzy edit matching: only the operations
 * underneath change.
 *
 * Bash stays Pi's local tool. Commands used to run in client terminals (ACP
 * terminal/create), but Zed freezes a terminal's output when its process
 * exits, before the last of it is processed, so results came back cut short
 * or empty. A client can still show the output live: the event bridge feeds
 * it to a terminal the client only displays, as the Claude Code and Codex
 * adapters do.
 */

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
 * Creates the tools the client advertised capabilities for. Returns an empty
 * array when it advertised none, leaving Pi's local tools in place.
 */
export function createAcpProxyTools({
  client,
  sessionId,
  capabilities,
  cwd,
}: AcpProxyToolOptions): ToolDefinition[] {
  const files = new ClientFiles(client, sessionId);
  // Each built-in definition has its own parameter and details types.
  const tools: ToolDefinition<any, any, any>[] = [];

  if (capabilities?.fs?.readTextFile) {
    tools.push(createReadToolDefinition(cwd, { operations: files.readOperations() }));
  }
  if (capabilities?.fs?.writeTextFile) {
    tools.push(createWriteToolDefinition(cwd, { operations: files.writeOperations() }));
  }
  if (capabilities?.fs?.readTextFile && capabilities.fs.writeTextFile) {
    tools.push(createEditToolDefinition(cwd, { operations: files.editOperations() }));
  }

  return tools;
}

/**
 * File access through the client, falling back to the disk when the client
 * refuses a path: Zed only serves files of the open project, while Pi may
 * touch any file.
 */
class ClientFiles {
  constructor(
    private readonly client: AgentContext,
    private readonly sessionId: string,
  ) {}

  readOperations(): ReadOperations {
    return {
      // Images are binary: the client only serves text, so they come from the disk.
      readFile: async (path) =>
        (await detectSupportedImageMimeTypeFromFile(path)) ? readFile(path) : this.read(path),
      access: (path) => this.access(path, constants.R_OK),
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    };
  }

  writeOperations(): WriteOperations {
    return {
      writeFile: (path, content) => this.write(path, content),
      mkdir: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
    };
  }

  editOperations(): EditOperations {
    return {
      readFile: (path) => this.read(path),
      writeFile: (path, content) => this.write(path, content),
      access: (path) => this.access(path, constants.R_OK | constants.W_OK),
    };
  }

  private async read(path: string): Promise<Buffer> {
    try {
      const { content } = await this.client.request("fs/read_text_file", {
        sessionId: this.sessionId,
        path,
      });
      return Buffer.from(content, "utf8");
    } catch {
      // The disk error names the path and the cause, unlike the client's.
      return readFile(path);
    }
  }

  private async write(path: string, content: string): Promise<void> {
    try {
      await this.client.request("fs/write_text_file", { sessionId: this.sessionId, path, content });
    } catch {
      await writeFile(path, content, "utf8");
    }
  }

  /** Checked on disk: ACP has no access check, and these files exist there. */
  private async access(path: string, mode: number): Promise<void> {
    await access(path, mode);
  }
}
