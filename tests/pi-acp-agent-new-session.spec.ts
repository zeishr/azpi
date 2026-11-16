import { describe, expect, it, mock } from "bun:test";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { mockClient } from "./mock-client";

let capturedCreateAgentSessionOptions: any;

// The tool factories stay real: AZPi builds its client tools from Pi's own.
const realPi = await import("@earendil-works/pi-coding-agent");

mock.module("@earendil-works/pi-coding-agent", () => ({
  ...realPi,
  VERSION: "0.0.0-test",
  ModelRuntime: {
    create: async () => ({}),
  },
  ModelRegistry: class {
    getAvailable() {
      return [];
    }
    find() {
      return undefined;
    }
  },
  SessionManager: {
    create: () => ({
      getSessionId: () => "real-session-id",
      getSessionFile: () => "/tmp/real-session.jsonl",
    }),
    list: mock(async () => []),
    listAll: mock(async () => []),
  },
  createAgentSession: mock(async (options: any) => {
    capturedCreateAgentSessionOptions = options;
    return {
      session: {
        sessionId: options.sessionManager.getSessionId(),
        sessionFile: options.sessionManager.getSessionFile(),
        model: undefined,
        thinkingLevel: "medium",
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
        setModel: mock(async () => {}),
        setThinkingLevel: mock(() => {}),
        subscribe: () => () => {},
        prompt: mock(async () => {}),
        abort: mock(async () => {}),
        dispose: mock(() => {}),
        bindExtensions: mock(async () => {}),
        resourceLoader: {
          getAgentsFiles: () => ({ agentsFiles: [] }),
          getSkills: () => ({ skills: [], diagnostics: [] }),
          getPrompts: () => ({ prompts: [], diagnostics: [] }),
          getThemes: () => ({ themes: [], diagnostics: [] }),
          getExtensions: () => ({ extensions: [], errors: [] }),
          getSystemPrompt: () => undefined,
          getAppendSystemPrompt: () => [],
          extendResources: mock(async () => {}),
          reload: mock(async () => {}),
        },
        sessionManager: options.sessionManager,
      },
    };
  }),
}));

const { PiAcpAgent } = await import("../src/pi-acp-agent");

describe("PiAcpAgent newSession without sessionFactory", () => {
  it("creates proxy tools with the real sessionId", async () => {
    const conn = mockClient({
      "terminal/create": async () => ({ terminalId: "term-1" }),
      "terminal/output": async () => ({
        output: "",
        exitStatus: { exitCode: 0 },
        truncated: false,
      }),
    });
    const agent = new PiAcpAgent(conn, {
      modelRuntime: {} as any,
      modelRegistry: {
        getAvailable: () => [],
        find: () => undefined,
      } as any,
    });

    await agent.initialize({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "test", version: "1.0" },
      protocolVersion: PROTOCOL_VERSION,
    });

    const result = await agent.newSession({ cwd: "/test", mcpServers: [] });
    expect(result.sessionId).toBe("real-session-id");

    expect(capturedCreateAgentSessionOptions).toBeDefined();
    expect(capturedCreateAgentSessionOptions.customTools).toBeDefined();
    expect(capturedCreateAgentSessionOptions.customTools.length).toBeGreaterThan(0);

    const bashTool = capturedCreateAgentSessionOptions.customTools.find(
      (t: any) => t.name === "bash",
    );
    expect(bashTool).toBeDefined();

    const toolContext = {
      cwd: "/test",
      sessionManager: { getSessionId: () => "real-session-id", getSessionFile: () => undefined },
    };
    await bashTool.execute("tc-1", { command: "echo hello" }, undefined, undefined, toolContext);

    expect(conn.method("terminal/create")).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "real-session-id",
        command: "echo hello",
      }),
    );
  });
});
