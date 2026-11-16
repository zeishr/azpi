<p align="center">
░░░░▓▓░░░▓▓▓▓▓▓░░▓▓▓▓▓▓░░░<br>
░░▓▓░░▓▓░░░░▓▓▓░░▓▓░░▓▓░░░<br>
░▓▓░▓▓░▓▓░▓▓░░░░░▓▓▓▓░░▓▓░<br>
░▓▓░░░░▓▓░▓▓▓▓▓▓░▓▓░░░░▓▓░<br>
</p>

# AZPi

A seamless ACP client built on top of the Pi coding agent.

> This is a maintained fork of [Th1nkK1D/azpi](https://github.com/Th1nkK1D/azpi). It tracks the
> latest Pi release and adds detailed tool call cards and subagent cards (see Features).

## Why?

The [Agent Client Protocol (ACP)](https://agentclientprotocol.com) standardizes communication between code editors/IDEs and coding agents. It breaks vendor lock-in, allowing both sides to innovate independently while giving developers the freedom to choose the best tools for their workflow—like me, as a fan of [Zed](https://zed.dev) and [Pi](https://pi.dev).

Pi does not support ACP out of the box. While there are a few ACP adapters that communicate with Pi via [RPC mode](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md) (such as [svkozak/pi-acp](https://github.com/svkozak/pi-acp), my main inspiration), that approach decouples the adapter from Pi to allow shared use of the same executable. However, this often results in ACP features being limited by Pi's RPC constraints.

**AZPi** takes a different approach by using [Pi's JavaScript SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md). This allows us to maximize Pi's functionality and support a broader range of ACP specifications, trading off the requirement of bundling the Pi coding agent within the package.

## Features

- **Pi interoperability** — Shares settings, API keys, sessions, extensions, and user prompts with the Pi coding agent.
- **Model & thinking selection** — Exposed as ACP configuration options and synced bidirectionally.
- **Startup message** — Displays Pi version, loaded contexts, extensions, and skills upon launch.
- **Rich content** — Handles `text`, `image`, `resource`, and `resource_link` content blocks.
- **Real-time event streaming** — Bridges text, thinking, tool execution, and session info changes directly to ACP.
- **Detailed tool calls** — Each call gets a readable title, an ACP kind (icon), the files it touches for follow-along, and content suited to the tool: a diff per edit, highlighted code for reads, console output for bash. Reopened sessions look the same as live ones.
- **Subagent cards** — [pi-subagents](https://github.com/nicobailon/pi-subagents) runs show their children live: one card per workflow child, or the single child in the call's own card, with model, counters, current and recent tools, then the output.
- **Context, compaction and retries** — Reports context fill and cost after each turn (`usage_update`), and compactions and auto-retries to clients that support them.
- **Auto session naming** — Automatically derives session names from the initial prompt. Set `AZPI_SESSION_NAMING_MODEL` to a `provider/modelId` to generate names via LLM. Falls back to the heuristic trimming method.
- **Client tool proxy** — Runs Pi's own `read`, `write`, `edit`, and `bash` tools with their file and process access routed through the ACP client when available, enabling editors like Zed to show unsaved buffers to the agent, review its edits, and display live terminals. Paths the client refuses (outside its project) fall back to the disk.
- **Handshake record** — Keeps the client's last `initialize` request in `$XDG_STATE_HOME/azpi/last-initialize.json` (default `~/.local/state`), to check what the editor advertises.
- **Slash commands** — Supports Pi's built-in commands (`/name`, `/session`, `/compact`, `/export`, and `/reload`), skills, prompt templates, and extension commands (opt-in via `AZPI_ALLOW_EXTENSION_COMMANDS`, disabled by default).

## Usage

The package is not yet pre-built or published. You can clone the repository, install dependencies and run AZPi using [Bun](https://bun.com/):

```bash
git clone https://github.com/zeishr/azpi.git
cd azpi
bun i
```

AZPi bundles the Pi SDK, since the `pi` CLI ships as a compiled binary. Both share settings and
sessions, so keep them on the same version: the startup message warns when they drift, and
`bun run sync:pi` aligns the bundled SDK with `pi --version`.

An example configuration for Zed:

```jsonc
"agent_servers": {
  "AZPi": {
    "type": "custom",
    "command": "bun",
    "args": ["/path/to/repository"],
    "env": {
      // Extension commands exposed to ACP clients (disabled by default)
      // Set to `*` to allow all extension commands
      "AZPI_ALLOW_EXTENSION_COMMANDS": "deploy,compress-stats",
      // Set a model for auto session naming
      "AZPI_SESSION_NAMING_MODEL": "opencode-go/deepseek-v4-flash",
      // Handle package installation via CLI rather than automatically through the SDK
      "PI_OFFLINE": "true"
    }
  }
}
```

If you haven't set up the Pi coding agent before, please refer to the [Pi configuration guide](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) or at least configure your [API keys](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md#api-keys) to enable LLM access.

## Limitations / Future Improvements

- **No interactive provider authentication** via the `/login` command; uses [API Keys](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md#api-keys) instead.
- **[MCP](https://agentclientprotocol.com/protocol/session-setup#mcp-servers) and [agent plans](https://agentclientprotocol.com/protocol/agent-plan)** are conflicted with Pi's [philosophy](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#philosophy) and are unlikely to be implemented.
- **Interactive dialogs are not supported.** Pi's `/tree`, `/fork`, and extension commands calling ctx.ui `confirm()`, `select()`, `input()`, `editor()`, or `custom()` use Pi native TUI rendering.
  - **ACP elicitation** (`elicitation/create`) could bridge interactive dialogs in the future, but the protocol is still [an RFD](https://agentclientprotocol.com/rfds/elicitation) and not yet implemented.
- **No published package** on NPM yet.
