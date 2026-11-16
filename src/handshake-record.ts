import type { InitializeRequest } from "@agentclientprotocol/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Keeps the last initialize request on disk.
 *
 * What a client advertises decides what AZPi sends (subagent sessions,
 * compaction updates, notices), and editors do not always make it easy to
 * see: Zed shows it only in an in-memory log pane.
 */
export function handshakeRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "azpi", "last-initialize.json");
}

export async function recordHandshake(
  request: InitializeRequest,
  path: string = handshakeRecordPath(),
): Promise<void> {
  const record = {
    receivedAt: new Date().toISOString(),
    protocolVersion: request.protocolVersion,
    clientInfo: request.clientInfo,
    clientCapabilities: request.clientCapabilities,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, undefined, 2)}\n`, "utf8");
}
