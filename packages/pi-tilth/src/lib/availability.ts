import type { Exec } from "./exec";

/**
 * How the tilth MCP server is reached this session.
 *
 * - `binary`: a `tilth` binary found on PATH (spawned once per session as a
 *   persistent stdio child process).
 * - `npx`: `npx -y tilth --mcp` fallback (first connect may download).
 * - `unavailable`: nothing usable was found.
 */
export type TransportMode = "binary" | "npx" | "unavailable";

async function probe(exec: Exec, cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
	try {
		const result = await exec(cmd, args, { timeout: timeoutMs });
		return result.code === 0 && !result.killed;
	} catch {
		return false;
	}
}

export interface AvailabilityState {
	/**
	 * The resolved transport mode. `undefined` before the first `refresh()`
	 * call — tools treat `undefined` as "probe has not completed yet".
	 */
	mode: TransportMode | undefined;
	/** Re-probe the transport chain; safe to call again at any time. */
	refresh(exec: Exec): Promise<void>;
}

/**
 * Create a mutable availability state object. `session_start` calls
 * `refresh()` once; the tools read `mode` synchronously per call.
 *
 * Probe order (per spec): `tilth` binary → `npx` fallback → unavailable.
 */
export function createAvailabilityState(): AvailabilityState {
	return {
		mode: undefined,
		async refresh(exec: Exec): Promise<void> {
			if (await probe(exec, "tilth", ["--version"], 10_000)) {
				this.mode = "binary";
				return;
			}
			if (await probe(exec, "npx", ["--version"], 10_000)) {
				this.mode = "npx";
				return;
			}
			this.mode = "unavailable";
		},
	};
}

/**
 * The remediation text shown when tilth is unavailable — also used by tools
 * and the `/tilth-savings` command so every surface says the same thing.
 */
export function unavailableMessage(): string {
	return (
		"tilth is not available: no `tilth` binary on PATH and the npx fallback failed.\n" +
		"Fix (pick one):\n" +
		"  1. Install the tilth binary: cargo install tilth (or npm i -g tilth).\n" +
		"  2. Ensure npx is on PATH so tilth can be fetched on first use (the first call then downloads it)."
	);
}
