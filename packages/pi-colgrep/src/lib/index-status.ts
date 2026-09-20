/**
 * Probe whether a colgrep index already exists for a project directory.
 *
 * `colgrep status <path>` exits 0 whether or not an index exists and has no
 * `--json` mode, so existence is parsed from stdout: the literal
 * `No index found` is the stable negative signal.
 */
import type { Exec } from "./exec";

/** True unless `colgrep status` reports that no index exists for the project. */
export function indexExistsFromStatus(stdout: string): boolean {
  return !stdout.includes("No index found");
}

/**
 * Run `colgrep status` and report whether an index exists for `cwd`.
 *
 * Degrades to `false` on any exec failure (non-zero exit or thrown error) —
 * "no index" only suppresses proactive reindexing; a real search still
 * auto-indexes on demand.
 */
export async function checkIndexExists(
  exec: Exec,
  cwd: string,
): Promise<boolean> {
  try {
    const result = await exec("colgrep", ["status", cwd, "--color", "never"], {
      cwd,
      timeout: 5000,
    });
    if (result.code !== 0) return false;
    return indexExistsFromStatus(result.stdout);
  } catch {
    return false;
  }
}
