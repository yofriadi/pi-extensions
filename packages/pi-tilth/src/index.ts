/**
 * pi-tilth — tilth code-intelligence tools for pi-coding-agent via mcporter.
 *
 * Entry wiring: session_start loads config, resolves transport availability
 * (configured mcporter server → tilth binary → npx → unavailable) and
 * notifies on degraded modes; registers the six tools and /tilth-savings.
 * Tools consult availability per call and throw the static explanatory error
 * when unavailable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerSavingsCommand } from "./commands/savings";
import { createAvailabilityState, unavailableMessage } from "./lib/availability";
import { getGlobalConfigPath, getProjectConfigPath, loadConfig } from "./lib/config";
import { type CompatModule, resolveCompatModule } from "./lib/hashline-bridge";
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
		serverName: "tilth",
		callTimeoutMs: 60_000,
		hashlineCompat: true,
	};

	const deps: TilthToolDeps = {
		exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
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

		await availability.refresh(pi.exec.bind(pi), config.serverName);

		// Guarded dynamic import — sanctioned exception to the repo
		// no-dynamic-imports rule (each extension must work standalone).
		compat = config.hashlineCompat ? await resolveCompatModule() : null;

		if (availability.mode === "unavailable") {
			ctx.ui.notify(unavailableMessage(), "warning");
			return;
		}
		if (availability.mode === "npx") {
			ctx.ui.notify(
				"tilth was not found as a binary or configured mcporter server; " +
					"falling back to `npx -y tilth --mcp` per call. The first call may " +
					"download tilth and exceed the per-call timeout — if it times out, " +
					"simply retry. For session dedup, configure a keep-alive server:\n" +
					'{ "mcpServers": { "tilth": { "command": "tilth", "args": ["--mcp"], "lifecycle": "keep-alive", "idleTimeoutMs": 300000 } } }',
				"info",
			);
		}
	});
}
