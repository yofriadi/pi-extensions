import type { Exec } from "./exec";

export interface AvailabilityResult {
  available: boolean;
}

/**
 * Check whether the `colgrep` binary is present and responsive by running
 * `colgrep --version`. Returns `{ available: false }` on any failure so the
 * caller can degrade gracefully without catching.
 */
export async function checkAvailability(
  exec: Exec,
): Promise<AvailabilityResult> {
  try {
    const result = await exec("colgrep", ["--version"], { timeout: 5000 });
    return { available: result.code === 0 };
  } catch {
    return { available: false };
  }
}

export interface AvailabilityState {
  /** `undefined` before the first `refresh()` call. */
  available: boolean | undefined;
  refresh(exec: Exec): Promise<void>;
}

/**
 * Create a mutable availability state object that caches the result of the
 * most recent `checkAvailability()` call.
 *
 * The `session_start` handler calls `refresh()` once per session and stores
 * the result here. The tool's `execute()` reads `available` synchronously.
 */
export function createAvailabilityState(): AvailabilityState {
  return {
    available: undefined,
    async refresh(exec: Exec): Promise<void> {
      const result = await checkAvailability(exec);
      this.available = result.available;
    },
  };
}
