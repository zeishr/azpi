import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";
import { extractMessageText } from "./event-bridge";
import { SessionUpdateType } from "./session-update-types";
import { ToolCallMapper } from "./tool-call-mapper";

/**
 * Resolves a Pi session UUID to its JSONL file path.
 * Uses an in-memory cache first, then falls back to SessionManager.list()
 * and SessionManager.listAll() for cross-cwd lookup.
 */
export class SessionResolver {
  private cache = new Map<string, string>();

  registerSession(sessionId: string, path: string): void {
    this.cache.set(sessionId, path);
  }

  unregisterSession(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  async resolveSessionPath(cwd: string, sessionId: string): Promise<string | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const sessions = await SessionManager.list(cwd);
    for (const info of sessions) {
      if (info.id === sessionId) {
        this.cache.set(sessionId, info.path);
        return info.path;
      }
    }

    const allSessions = await SessionManager.listAll();
    for (const info of allSessions) {
      if (info.id === sessionId) {
        this.cache.set(sessionId, info.path);
        return info.path;
      }
    }

    return undefined;
  }

  async warmCache(cwd: string): Promise<void> {
    const sessions = await SessionManager.list(cwd);
    for (const info of sessions) {
      this.cache.set(info.id, info.path);
    }
  }
}

/**
 * Replays conversation history from a Pi session as ACP session/update notifications.
 *
 * Replays user messages, assistant text/thinking/tool-calls, and tool results
 * to faithfully reconstruct the original session appearance in the ACP client.
 * Non-message entries (compactions, branch summaries, model changes, etc.) are
 * skipped.
 */
export async function replaySessionHistory(
  session: AgentSession,
  sessionId: string,
  client: AgentContext,
): Promise<void> {
  // Walk active branch from leaf to root — getEntries() returns ALL
  // entries including abandoned branches, which would replay stale
  // messages from earlier /tree navigations.
  const entries = session.sessionManager.getBranch();
  const tools = new ToolCallMapper({ cwd: session.sessionManager.getCwd(), live: false });
  const updates: Promise<void>[] = [];
  const send = (update: SessionUpdate) =>
    updates.push(client.notify("session/update", { sessionId, update }));

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const message = entry.message;
    const role = message.role;

    if (role === "user") {
      const text = extractMessageText(message);
      if (text)
        send({
          sessionUpdate: SessionUpdateType.UserMessageChunk,
          content: { type: "text", text },
        });
    } else if (role === "assistant") {
      replayAssistantMessage(message as any, tools, send);
    } else if (role === "toolResult") {
      replayToolResult(message as any, tools, send);
    }
  }

  await Promise.all(updates);
}

/** Emit thinking, tool-call, and text blocks from an assistant message. */
function replayAssistantMessage(
  message: any,
  tools: ToolCallMapper,
  send: (update: SessionUpdate) => void,
): void {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length > 0) {
      send({
        sessionUpdate: SessionUpdateType.AgentMessageChunk,
        content: { type: "text", text: content },
      });
    }
    return;
  }

  if (!Array.isArray(content)) return;

  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "thinking") {
      const thinking = block.thinking;
      if (typeof thinking === "string" && thinking.length > 0) {
        send({
          sessionUpdate: SessionUpdateType.AgentThoughtChunk,
          content: { type: "text", text: thinking },
        });
      }
    } else if (block.type === "toolCall") {
      if (typeof block.id === "string" && typeof block.name === "string") {
        // Pending until its result entry, so a call that never got one does not look finished.
        tools.start(block.id, block.name, block.arguments, "pending").forEach(send);
      }
    } else if (block.type === "text") {
      const text = block.text;
      if (typeof text === "string" && text.length > 0) {
        send({
          sessionUpdate: SessionUpdateType.AgentMessageChunk,
          content: { type: "text", text },
        });
      }
    }
  }
}

/** Emit the tool_call_update of a tool result, plus the cards of any subagent children. */
function replayToolResult(
  message: any,
  tools: ToolCallMapper,
  send: (update: SessionUpdate) => void,
): void {
  if (typeof message.toolCallId !== "string") return;
  const name = String(message.toolName ?? "");
  tools.end(message.toolCallId, name, message, Boolean(message.isError)).forEach(send);
}
