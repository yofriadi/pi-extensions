import type { Exec } from "./exec";

export type ReindexStatusCallback = (status: string | undefined) => void;

export interface ReindexerDeps {
  exec: Exec;
  cwd: string;
  onStatus: ReindexStatusCallback;
  /** Debounce quiet period before a scheduled reindex fires. Defaults to 4000 ms. */
  debounceMs?: number;
  /** Exec timeout for the reindex command. Defaults to 300 000 ms (5 min). */
  timeoutMs?: number;
}

export interface Reindexer {
  /** Schedule a debounced reindex. Safe to call repeatedly. */
  schedule(): void;
  /** Run a reindex immediately, bypassing debounce. Resolves when complete. */
  runNow(): Promise<void>;
  /** Cancel pending timers and wait for any in-flight reindex to finish. */
  shutdown(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const INDEXING_STATUS = "colgrep: indexing\u2026";
const QUEUED_STATUS = "colgrep: indexing\u2026 (queued updates)";
const INDEXING_FAILED_STATUS = "colgrep: indexing failed";

export function createReindexer(deps: ReindexerDeps): Reindexer {
  const { exec, cwd, onStatus } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;
  let isShutdown = false;
  let inflightPromise: Promise<void> | undefined;

  async function runReindex(): Promise<void> {
    inFlight = true;
    onStatus(INDEXING_STATUS);
    let failed = false;
    try {
      const result = await exec("colgrep", ["init", "-y", "."], {
        cwd,
        timeout: timeoutMs,
      });
      if (result.code !== 0) {
        failed = true;
        const detail = result.stderr.trim();
        console.error(
          `colgrep reindex failed: ${detail || `exit code ${result.code}`}`,
        );
      }
    } catch (err) {
      failed = true;
      console.error("colgrep reindex failed:", err);
    }
    if (failed) {
      onStatus(INDEXING_FAILED_STATUS);
    }
    onStatus(undefined);
    inFlight = false;
    inflightPromise = undefined;

    // Drain: if a reindex was queued while we were running, start it now
    // (unless shut down in the meantime).
    if (queued && !isShutdown) {
      queued = false;
      inflightPromise = runReindex();
    }
  }

  // Start a run, coalescing with any in-flight run. A second caller (e.g. a
  // manual /colgrep-reindex firing during a backgrounded startup index) joins
  // the in-flight promise instead of launching a second `colgrep init`.
  // `runReindex()` sets `inFlight` synchronously before its first await, so the
  // guard is race-free against another synchronous caller.
  function startRun(): Promise<void> {
    if (inFlight && inflightPromise !== undefined) {
      return inflightPromise;
    }
    inflightPromise = runReindex();
    return inflightPromise;
  }

  return {
    runNow(): Promise<void> {
      return startRun();
    },
    schedule(): void {
      if (isShutdown) return;

      // While a reindex is in flight, mark a queued follow-up instead of
      // starting another debounce timer.
      if (inFlight) {
        if (!queued) {
          queued = true;
          onStatus(QUEUED_STATUS);
        }
        return;
      }
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        inflightPromise = runReindex();
      }, debounceMs);
    },
    async shutdown(): Promise<void> {
      isShutdown = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (inflightPromise !== undefined) {
        await inflightPromise;
      }
    },
  };
}
