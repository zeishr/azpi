import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { handshakeRecordPath, recordHandshake } from "../src/handshake-record";

describe("handshakeRecordPath", () => {
  it("lives under XDG_STATE_HOME when set", () => {
    expect(handshakeRecordPath({ XDG_STATE_HOME: "/state" })).toBe(
      "/state/azpi/last-initialize.json",
    );
  });

  it("defaults to ~/.local/state", () => {
    expect(handshakeRecordPath({})).toMatch(/\/\.local\/state\/azpi\/last-initialize\.json$/);
  });
});

describe("recordHandshake", () => {
  it("keeps what the client advertised, creating the directory", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "azpi-")), "nested", "last-initialize.json");

    await recordHandshake(
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "zed", version: "1.28.1" },
        clientCapabilities: { terminal: true },
      },
      path,
    );

    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "zed", version: "1.28.1" },
      clientCapabilities: { terminal: true },
    });
    expect(Date.parse(record.receivedAt)).not.toBeNaN();
  });
});
