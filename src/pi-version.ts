import { execFile } from "node:child_process";
import { version as BUNDLED_PI_VERSION } from "../node_modules/@earendil-works/pi-coding-agent/package.json";

const VERSION_PROBE_TIMEOUT_MS = 3000;

export { BUNDLED_PI_VERSION };

/**
 * Asks the installed `pi` CLI for its version.
 *
 * AZPi bundles its own copy of the Pi SDK because the CLI ships as a compiled
 * binary that cannot be imported. Both share settings and session files, so a
 * drift between them is worth surfacing. Resolves to undefined when the CLI is
 * missing or does not answer: the bundled SDK still works on its own.
 */
export function detectInstalledPiVersion(binary = "pi"): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout) => {
      const version = stdout.trim();
      resolve(error || !version ? undefined : version);
    });
  });
}

/**
 * Returns a user-facing warning when the bundled Pi SDK and the installed CLI
 * differ, or undefined when they match or the CLI version is unknown.
 */
export function describePiVersionDrift(
  bundled: string,
  installed: string | undefined,
): string | undefined {
  if (!installed || installed === bundled) return undefined;
  return (
    `Pi CLI is v${installed} but AZPi bundles the Pi SDK v${bundled}. ` +
    "Run `bun run sync:pi` in the AZPi repository to align them."
  );
}
