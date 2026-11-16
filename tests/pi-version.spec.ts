import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePiVersionDrift, detectInstalledPiVersion } from "../src/pi-version";

describe("describePiVersionDrift", () => {
  it("stays silent when both versions match", () => {
    expect(describePiVersionDrift("1.5.2", "1.5.2")).toBeUndefined();
  });

  it("stays silent when the installed version is unknown", () => {
    expect(describePiVersionDrift("1.5.2", undefined)).toBeUndefined();
  });

  it("names both versions and the fix when they differ", () => {
    const warning = describePiVersionDrift("1.5.2", "1.6.0");
    expect(warning).toContain("v1.6.0");
    expect(warning).toContain("v1.5.2");
    expect(warning).toContain("bun run sync:pi");
  });
});

describe("detectInstalledPiVersion", () => {
  it("resolves to undefined when the binary does not exist", async () => {
    expect(await detectInstalledPiVersion("/nonexistent/pi-binary")).toBeUndefined();
  });

  it("returns the trimmed output of --version", async () => {
    const fakePi = join(mkdtempSync(join(tmpdir(), "azpi-")), "pi");
    writeFileSync(fakePi, "#!/bin/sh\necho 1.6.0\n");
    chmodSync(fakePi, 0o755);
    expect(await detectInstalledPiVersion(fakePi)).toBe("1.6.0");
  });
});
