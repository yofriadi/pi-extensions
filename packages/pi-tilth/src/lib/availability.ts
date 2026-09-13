import type { Exec } from "./exec";

/**
 * How the tilth MCP server is reached this session.
 *
 * - `config`: a configured mcporter server entry (preferred — enables tilth's
 *   session dedup via mcporter's keep-alive daemon).
 * - `binary`: ad-hoc stdio spawn of a `tilth` binary found on PATH.
 * - `npx`: ad-hoc stdio spawn of `npx -y tilth --mcp` (first call may download).
 * - `unavailable`: nothing usable was found.
 */
export type TransportMode = "config" | "binary" | "npx" | "unavailable";

/** Stdio command + args for ad-hoc modes (repeated on every call). */
export interface AdHocDescriptor {
	cmd: string;
	stdioArgs: string[];
}

const BINARY_DESCRIPTOR: AdHocDescriptor = { cmd: "tilth", stdioArgs: ["--mcp"] };
const NPX_DESCRIPTOR: AdHocDescriptor = {
	cmd: "npx",
	stdioArgs: ["-y", "tilth", "--mcp"],
};

export function getAdHocDescriptor(mode: "binary" | "npx"): AdHocDescriptor {
	return mode === "binary" ? BINARY_DESCRIPTOR : NPX_DESCRIPTOR;
}

async function probe(exec: Exec, cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
	try {
		const result = await exec(cmd, args, { timeout: timeoutMs });
		return result.code === 0 && !result.killed;
	} catch {
		return false;
	}
}

/**
 * Probe mcporter for a configured server entry named `serverName`.
 * `mcporter list <name> --status --json --quiet` exits 0 only when the server
 * resolves and is healthy; a missing entry exits non-zero without spawning it.
 */
export async function checkConfiguredServer(exec: Exec, serverName: string): Promise<boolean> {
	return probe(exec, "mcporter", ["list", serverName, "--status", "--json", "--quiet"], 10_000);
}

export interface AvailabilityState {
	/**
	 * The resolved transport mode. `undefined` before the first `refresh()`
	 * call — tools treat `undefined` as "probe has not completed yet".
	 */
	mode: TransportMode | undefined;
	/** Re-probe the transport chain; safe to call again at any time. */
	refresh(exec: Exec, serverName: string): Promise<void>;
}

/**
 * Create a mutable availability state object. `session_start` calls
 * `refresh()` once; the tools read `mode` synchronously per call.
 *
 * Probe order (per spec): configured mcporter server → `tilth` binary →
 * `npx` fallback → unavailable.
 */
export function createAvailabilityState(): AvailabilityState {
	return {
		mode: undefined,
		async refresh(exec: Exec, serverName: string): Promise<void> {
			if (await checkConfiguredServer(exec, serverName)) {
				this.mode = "config";
				return;
			}
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
		"tilth is not available: no configured mcporter server, no `tilth` binary, and npx fallback failed.\n" +
		"Fix (pick one):\n" +
		"  1. Configure mcporter (recommended — enables session dedup). Add to ~/.mcporter/mcporter.json:\n" +
		'     { "mcpServers": { "tilth": { "command": "tilth", "args": ["--mcp"], "lifecycle": "keep-alive", "idleTimeoutMs": 300000 } } }\n' +
		"     (or: mcporter config add tilth --stdio tilth --arg --mcp)\n" +
		"     Dedup additionally requires a healthy mcporter daemon (mcporter daemon status).\n" +
		"  2. Install the tilth binary: cargo install tilth (or npm i -g tilth).\n" +
		"  3. Ensure npx is on PATH so tilth can be fetched ad hoc (first call downloads it)."
	);
}
