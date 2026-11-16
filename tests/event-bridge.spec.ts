import { describe, expect, it } from "bun:test";
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import type { StopReason } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import {
  SessionEventBridge,
  buildUsageUpdate,
  mapFinalContent,
  mapStopReason,
} from "../src/event-bridge";

const SID = "test-session";

function bridge(capabilities?: ClientCapabilities): SessionEventBridge {
  return new SessionEventBridge({ sessionId: SID, cwd: "/repo", capabilities });
}

const asEvent = (value: unknown) => value as AgentSessionEvent;

/** For events that map to one notification at most, which is all but subagent calls. */
function mapOne(
  b: SessionEventBridge,
  e: AgentSessionEvent,
  configOptions?: SessionConfigOption[],
): SessionNotification | null {
  const notifications = b.map(e, configOptions);
  expect(notifications.length).toBeLessThanOrEqual(1);
  return notifications[0] ?? null;
}

describe("event-bridge", () => {
  describe("SessionEventBridge", () => {
    it("maps message_update text_delta to agent_message_chunk", () => {
      const event = {
        assistantMessageEvent: { delta: "Hello world", type: "text_delta" },
        message: { content: "Hello world", role: "assistant" },
        type: "message_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("agent_message_chunk");
      expect(result!.sessionId).toBe(SID);
      expect((result!.update as any).content.text).toBe("Hello world");
    });

    it("returns null for message_update with empty delta", () => {
      const event = {
        assistantMessageEvent: { delta: "", type: "text_delta" },
        message: { content: [], role: "assistant" },
        type: "message_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).toBeNull();
    });

    it("returns null for message_update non-text_delta assistantMessageEvent", () => {
      const event = {
        assistantMessageEvent: { type: "text_start" },
        message: { content: "Hello world", role: "assistant" },
        type: "message_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).toBeNull();
    });

    it("maps tool_execution_start to tool_call", () => {
      const event = {
        args: { command: "ls" },
        toolCallId: "tc-1",
        toolName: "bash",
        type: "tool_execution_start" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("tool_call");
      expect(result!.sessionId).toBe(SID);
      expect((result!.update as any).toolCallId).toBe("tc-1");
      // Pi emits tool_execution_start when the tool actually starts running.
      expect((result!.update as any).status).toBe("in_progress");
      expect((result!.update as any).title).toBe("`ls`");
      expect((result!.update as any).kind).toBe("execute");
    });

    it("keeps a tool's arguments from start to end, where its result needs them", () => {
      const b = bridge();
      mapOne(
        b,
        asEvent({
          type: "tool_execution_start",
          toolCallId: "tc-read",
          toolName: "read",
          args: { path: "src/main.rs" },
        }),
      );
      const end = mapOne(
        b,
        asEvent({
          type: "tool_execution_end",
          toolCallId: "tc-read",
          toolName: "read",
          result: { content: [{ type: "text", text: "fn main() {}" }] },
          isError: false,
        }),
      );
      // The language comes from the path given at start, absent from the end event.
      expect((end!.update as any).content[0].content.text).toBe("```rs\nfn main() {}\n```");
    });

    it("leaves a terminal-backed bash card alone while it streams", () => {
      const update = mapOne(
        bridge(),
        asEvent({
          type: "tool_execution_update",
          toolCallId: "tc-sh",
          toolName: "bash",
          args: { command: "sleep 1" },
          partialResult: {
            content: [{ type: "text", text: "..." }],
            details: { terminalId: "t1" },
          },
        }),
      );
      expect(update).toBeNull();
    });

    it("ends a terminal-backed bash call without resending the released terminal", () => {
      const end = mapOne(
        bridge(),
        asEvent({
          type: "tool_execution_end",
          toolCallId: "tc-sh",
          toolName: "bash",
          result: { content: [{ type: "text", text: "done" }], details: { terminalId: "t1" } },
          isError: false,
        }),
      );
      expect((end!.update as any).status).toBe("completed");
      expect("content" in end!.update).toBe(false);
    });

    it("maps tool_execution_update to tool_call_update", () => {
      const event = {
        args: { command: "ls" },
        partialResult: { output: "file.txt" },
        toolCallId: "tc-1",
        toolName: "bash",
        type: "tool_execution_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("tool_call_update");
      expect((result!.update as any).status).toBe("in_progress");
    });

    it("maps successful tool_execution_end to tool_call_update with completed", () => {
      const event = {
        isError: false,
        result: { code: 0, output: "done" },
        toolCallId: "tc-1",
        toolName: "bash",
        type: "tool_execution_end" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("tool_call_update");
      expect((result!.update as any).status).toBe("completed");
    });

    it("maps failed tool_execution_end to tool_call_update with failed", () => {
      const event = {
        isError: true,
        result: { error: "fail" },
        toolCallId: "tc-1",
        toolName: "bash",
        type: "tool_execution_end" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("tool_call_update");
      expect((result!.update as any).status).toBe("failed");
    });

    it("returns null for agent_start", () => {
      const event = { type: "agent_start" as const } as unknown as AgentSessionEvent;
      expect(mapOne(bridge(), event)).toBeNull();
    });

    it("returns null for agent_end", () => {
      const event = {
        messages: [],
        type: "agent_end" as const,
      } as unknown as AgentSessionEvent;
      expect(mapOne(bridge(), event)).toBeNull();
    });

    it("maps message_update thinking_delta to agent_thought_chunk", () => {
      const event = {
        assistantMessageEvent: { delta: "Let me think...", type: "thinking_delta" },
        message: { content: "Let me think...", role: "assistant" },
        type: "message_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("agent_thought_chunk");
      expect(result!.sessionId).toBe(SID);
      expect((result!.update as any).content.text).toBe("Let me think...");
    });

    it("returns null for message_update thinking_delta with empty delta", () => {
      const event = {
        assistantMessageEvent: { delta: "", type: "thinking_delta" },
        message: { content: [], role: "assistant" },
        type: "message_update" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).toBeNull();
    });

    it("maps session_info_changed to session_info_update", () => {
      const event = {
        name: "My Session",
        type: "session_info_changed" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("session_info_update");
      expect(result!.sessionId).toBe(SID);
      expect((result!.update as any).title).toBe("My Session");
    });

    it("maps session_info_changed with undefined name to null title", () => {
      const event = {
        name: undefined,
        type: "session_info_changed" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("session_info_update");
      expect((result!.update as any).title).toBeNull();
    });

    it("maps thinking_level_changed to config_option_update when configOptions provided", () => {
      const event = {
        level: "high",
        type: "thinking_level_changed" as const,
      } as unknown as AgentSessionEvent;
      const configOptions: SessionConfigOption[] = [
        {
          id: "thinking-level",
          category: "thought_level",
          name: "Thinking",
          options: [],
          currentValue: "high",
          type: "select",
        },
      ];
      const result = mapOne(bridge(), event, configOptions);
      expect(result).not.toBeNull();
      expect(result!.update.sessionUpdate).toBe("config_option_update");
      expect(result!.sessionId).toBe(SID);
      expect((result!.update as any).configOptions).toBe(configOptions);
    });

    it("returns null for thinking_level_changed when configOptions not provided", () => {
      const event = {
        level: "high",
        type: "thinking_level_changed" as const,
      } as unknown as AgentSessionEvent;
      const result = mapOne(bridge(), event);
      expect(result).toBeNull();
    });
  });

  describe("compaction updates", () => {
    const start = asEvent({ type: "compaction_start", reason: "threshold" });
    const end = (fields: Record<string, unknown>) =>
      asEvent({ type: "compaction_end", reason: "threshold", willRetry: false, ...fields });
    const compactionClient = { session: { compaction: {} } } as ClientCapabilities;

    it("stays silent for a client that did not advertise compaction support", () => {
      const b = bridge();
      expect(mapOne(b, start)).toBeNull();
      expect(mapOne(b, end({ aborted: false, result: { summary: "s" } }))).toBeNull();
    });

    it("announces a compaction and completes it under the same id", () => {
      const b = bridge(compactionClient);
      const started = mapOne(b, start)!.update as any;
      const ended = mapOne(b, end({ aborted: false, result: { summary: "Kept the plan" } }))!
        .update as any;
      expect(started).toMatchObject({ sessionUpdate: "compaction_update", status: "in_progress" });
      expect(ended.compactionId).toBe(started.compactionId);
      expect(ended.status).toBe("completed");
      expect(ended.summary).toEqual([{ type: "text", text: "Kept the plan" }]);
    });

    it("gives each compaction its own id", () => {
      const b = bridge(compactionClient);
      const first = (mapOne(b, start)!.update as any).compactionId;
      mapOne(b, end({ aborted: false, result: { summary: "s" } }));
      expect((mapOne(b, start)!.update as any).compactionId).not.toBe(first);
    });

    it("reports aborted and failed compactions", () => {
      const b = bridge(compactionClient);
      mapOne(b, start);
      expect((mapOne(b, end({ aborted: true }))!.update as any).status).toBe("cancelled");
      mapOne(b, start);
      const failed = mapOne(b, end({ aborted: false, errorMessage: "model refused" }))!
        .update as any;
      expect(failed).toMatchObject({ status: "failed", error: "model refused" });
    });
  });

  describe("retry notices", () => {
    const retry = asEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "overloaded",
    });
    const noticesClient = { session: { notices: {} } } as ClientCapabilities;

    it("stays silent for a client that did not advertise notice support", () => {
      expect(mapOne(bridge(), retry)).toBeNull();
    });

    it("warns about a retry with the error that caused it", () => {
      expect(mapOne(bridge(noticesClient), retry)!.update).toEqual({
        sessionUpdate: "notice",
        severity: "warning",
        title: "Retrying after an error (attempt 1 of 3)",
        description: "overloaded",
      });
    });

    it("reports a final failure but not a successful retry", () => {
      const b = bridge(noticesClient);
      expect(mapOne(b, asEvent({ type: "auto_retry_end", success: true, attempt: 2 }))).toBeNull();
      const failure = mapOne(
        b,
        asEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }),
      )!.update as any;
      expect(failure).toMatchObject({ severity: "error", description: "overloaded" });
    });
  });

  describe("buildUsageUpdate", () => {
    it("reports the context fill and the session cost", () => {
      expect(
        buildUsageUpdate({ tokens: 1234.6, contextWindow: 200000, percent: 0.6 }, 0.42),
      ).toEqual({
        sessionUpdate: "usage_update",
        used: 1235,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      });
    });

    it("skips the update while Pi does not know the context fill", () => {
      expect(
        buildUsageUpdate({ tokens: null, contextWindow: 200000, percent: null }, 0),
      ).toBeNull();
      expect(buildUsageUpdate(undefined, 0)).toBeNull();
    });
  });

  describe("mapStopReason", () => {
    it.each([
      ["aborted", "cancelled"],
      ["length", "max_tokens"],
      ["error", "end_turn"],
      ["stop", "end_turn"],
      ["toolUse", "end_turn"],
      [undefined, "end_turn"],
    ])("maps %s → %s", (input, expected) => {
      const msg = { role: "assistant" as const, stopReason: input };
      expect(mapStopReason(msg as unknown as AgentMessage)).toBe(expected as StopReason);
    });

    it("returns end_turn for non-assistant messages", () => {
      expect(mapStopReason({ role: "user" } as unknown as AgentMessage)).toBe("end_turn");
    });

    it("returns end_turn for undefined", () => {
      expect(mapStopReason(undefined)).toBe("end_turn");
    });
  });

  describe("mapFinalContent", () => {
    it("extracts text from string content", () => {
      const msg = { role: "user" as const, content: "Final answer", timestamp: 0 };
      const result = mapFinalContent(msg as unknown as AgentMessage);
      expect(result).toEqual([{ text: "Final answer", type: "text" }]);
    });

    it("extracts text from array content", () => {
      const msg = {
        role: "user" as const,
        content: [{ text: "Array answer", type: "text" }],
        timestamp: 0,
      };
      const result = mapFinalContent(msg as unknown as Parameters<typeof mapFinalContent>[0]);
      expect(result).toEqual([{ text: "Array answer", type: "text" }]);
    });

    it("returns empty array for no text", () => {
      const msg = { role: "user" as const, content: [], timestamp: 0 };
      expect(mapFinalContent(msg as unknown as Parameters<typeof mapFinalContent>[0])).toEqual([]);
    });

    it("returns empty array for undefined message", () => {
      expect(mapFinalContent(undefined)).toEqual([]);
    });
  });
});
