/**
 * pi-tilth — tilth code-intelligence tools for pi-coding-agent over a
 * persistent in-process MCP stdio connection.
 *
 * Entry wiring: session_start loads config, probes tilth availability
 * (tilth binary → npx → unavailable), constructs the transport wrapper
 * (lazily connected on the first tool call) and notifies on degraded modes;
 * registers the six tools and /tilth-savings. session_shutdown tears the
 * transport down idempotently (quit, reload, new, resume, fork). Tools
 * consult availability per call and throw the static explanatory error when
 * unavailable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerSavingsCommand } from "./commands/savings";
import { createAvailabilityState, unavailableMessage } from "./lib/availability";
import { getGlobalConfigPath, getProjectConfigPath, loadConfig } from "./lib/config";
import { type CompatModule, resolveCompatModule } from "./lib/hashline-bridge";
import { TilthMcpTransport } from "./lib/transport";
import type { TilthToolDeps } from "./toolkit";
import { registerDepsTool } from "./tools/deps";
import { registerDiffTool } from "./tools/diff";
import { registerGrokTool } from "./tools/grok";
import { registerListTool } from "./tools/list";
import { registerReadTool } from "./tools/read";
import { registerSearchTool } from "./tools/search";

export default function piTilthExtension(pi: ExtensionAPI): void {
	const availability = createAvailabilityState();
	// Opt-out flag for sessions that don't want hashline anchors on
	// tilth_read (e.g. read-only subagents). Overrides the config key.
	pi.registerFlag("tilth-no-hashline", {
		description:
			"Disable hashline-edit anchor annotation of tilth_read output (overrides the hashlineCompat config key). Useful for read-only sessions where edit anchors add only token overhead.",
		type: "boolean",
		default: false,
	});

	// Compat module is resolved lazily at session_start; tools read the
	// settled value per call (cheap, never re-imports).
	let compat: CompatModule | null = null;
	let config = {
		callTimeoutMs: 60_000,
		hashlineCompat: true,
	};
	// Transport is (re)constructed at session_start; null before the first
	// start and after shutdown. Connection is lazy: the stdio child process
	// spawns on the first tool call, not at session start.
	let transport: TilthMcpTransport | null = null;

	const deps: TilthToolDeps = {
		get transport() {
			if (transport === null) {
				throw new Error("tilth transport is not initialized yet. Try again shortly.");
			}
			return transport;
		},
		availability,
		get config() {
			return config;
		},
		get compat() {
			return compat;
		},
	};

	registerSearchTool(pi, deps);
	registerReadTool(pi, deps);
	registerListTool(pi, deps);
	registerDepsTool(pi, deps);
	registerGrokTool(pi, deps);
	registerDiffTool(pi, deps);
	registerSavingsCommand(pi, deps);

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig({
			globalConfigPath: getGlobalConfigPath(getAgentDir()),
			projectConfigPath: getProjectConfigPath(ctx.cwd),
		});
		// CLI opt-out wins over config: read-only sessions (e.g. subagents
		// with read permission only) skip anchor annotation entirely.
		if (pi.getFlag("tilth-no-hashline") === true) {
			config = { ...config, hashlineCompat: false };
		}

		await availability.refresh(pi.exec.bind(pi));

		// Guarded dynamic import — sanctioned exception to the repo
		// no-dynamic-imports rule (each extension must work standalone).
		compat = config.hashlineCompat ? await resolveCompatModule() : null;

		const mode = availability.mode;
		if (mode === "unavailable" || mode === undefined) {
			ctx.ui.notify(unavailableMessage(), "warning");
			return;
		}
		transport = new TilthMcpTransport({
			mode,
			config,
			cwd: ctx.cwd,
		});
		if (mode === "npx") {
			ctx.ui.notify(
				"tilth was not found as a binary; falling back to `npx -y tilth --mcp` on a persistent " +
					"in-process connection. The first tool call may download tilth and can take a while " +
					"(the connect budget is 120s) — later calls are fast. Install the binary for instant startup: " +
					"cargo install tilth (or npm i -g tilth).",
				"info",
			);
		}
	});

	// Idempotent teardown for every shutdown reason (quit, reload, new,
	// resume, fork). `disposed` guards post-shutdown respawns; a later
	// session_start constructs a fresh transport.
	pi.on("session_shutdown", async () => {
		const current = transport;
		transport = null;
		await current?.stop();
	});
}
