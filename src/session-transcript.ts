import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Follows a Pi session file as the session writes it, keeping what a tool
 * card can show of it: the assistant's text and its tool calls.
 *
 * A subagent child writes its own session file entry by entry, so reading
 * what was appended since the last look gives its transcript while it runs.
 */

export type TranscriptStep =
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      status: "running" | "completed" | "failed";
    }
  | { kind: "text"; text: string };

type Row = Record<string, unknown>;

export class SessionFileTail {
  readonly steps: TranscriptStep[] = [];
  /** Working directory of the session, from the file's header, once read. */
  cwd: string | undefined;
  private offset = 0;
  private partialLine = "";
  // Streaming, so a character split across two reads decodes whole.
  private readonly decoder = new TextDecoder();

  constructor(readonly path: string) {}

  /** Reads what was appended since the last call; true when the transcript changed. */
  refresh(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      // The child creates its session file with its first entry; until then
      // there is nothing to show, and an unreadable file has nothing either.
      return false;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return false;
      const buffer = Buffer.alloc(size - this.offset);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      return this.consume(this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    } finally {
      closeSync(fd);
    }
  }

  /** Applies the complete lines of `text`, keeping a trailing partial line for the next read. */
  private consume(text: string): boolean {
    const lines = (this.partialLine + text).split("\n");
    this.partialLine = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      const entry = parseEntry(line);
      if (!entry) continue;
      if (entry.type === "session" && typeof entry.cwd === "string") this.cwd = entry.cwd;
      changed = applyEntry(this.steps, entry) || changed;
    }
    return changed;
  }
}

/**
 * Applies one session entry to a transcript: an assistant message adds its
 * text and tool calls, a tool result settles the call it answers. Other
 * entries (model changes, the user prompt, compactions) add nothing a card
 * shows. Returns whether the transcript changed.
 */
export function applyEntry(steps: TranscriptStep[], entry: Row): boolean {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return false;
  }
  const message = entry.message as Row;
  if (message.role === "assistant") return addAssistantSteps(steps, message.content);
  if (message.role === "toolResult") return settleToolCall(steps, message);
  return false;
}

function addAssistantSteps(steps: TranscriptStep[], content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const before = steps.length;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      steps.push({ kind: "text", text: block.text });
    } else if (block?.type === "toolCall" && typeof block.id === "string") {
      steps.push({
        kind: "tool",
        id: block.id,
        name: typeof block.name === "string" ? block.name : "tool",
        args: block.arguments,
        status: "running",
      });
    }
  }
  return steps.length > before;
}

function settleToolCall(steps: TranscriptStep[], result: Row): boolean {
  const step = steps.find(
    (candidate) => candidate.kind === "tool" && candidate.id === result.toolCallId,
  );
  if (!step || step.kind !== "tool") return false;
  step.status = result.isError === true ? "failed" : "completed";
  return true;
}

/**
 * A line Pi did not finish writing, or a corrupt one, cannot be read: it is
 * skipped rather than losing the rest of the transcript.
 */
function parseEntry(line: string): Row | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    return entry && typeof entry === "object" ? (entry as Row) : undefined;
  } catch {
    return undefined;
  }
}
