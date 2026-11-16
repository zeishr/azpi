/**
 * Entry point for the Pi ACP adapter.
 * Wires stdio to ndJsonStream and serves the AZPi agent app over it.
 */

import { ndJsonStream } from "@agentclientprotocol/sdk";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Readable, Writable } from "node:stream";
import { recordHandshake } from "./handshake-record";
import { createAgentApp } from "./pi-acp-agent";
import { BUNDLED_PI_VERSION, describePiVersionDrift, detectInstalledPiVersion } from "./pi-version";

// Started before the model runtime so the CLI probe overlaps with startup work.
const startupWarning = detectInstalledPiVersion().then((installed) =>
  describePiVersionDrift(BUNDLED_PI_VERSION, installed),
);
const modelRuntime = await ModelRuntime.create();
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const onInitialize = (request: Parameters<typeof recordHandshake>[0]) => {
  // A diagnostic aid: failing to keep it must not stop the agent.
  recordHandshake(request).catch((error: unknown) => {
    console.error(`AZPi could not record the client handshake: ${String(error)}`);
  });
};
const connection = createAgentApp({ modelRuntime, startupWarning, onInitialize }).connect(stream);

await connection.closed;
