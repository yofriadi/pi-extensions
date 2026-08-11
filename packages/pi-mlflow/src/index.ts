import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { setupTracing } from "./setup.ts";
import { createInitialState } from "./state.ts";
import { registerStatusCommand } from "./status-command.ts";

/**
 * pi-mlflow: traces each pi turn-cycle (agent_start -> agent_settled) as an
 * MLflow trace against a user-managed local MLflow Tracking Server.
 *
 * Setup is deferred to `session_start` (not the extension factory) per pi's
 * documented guidance: extension factories may run in invocations that never
 * start a session, so background/network work belongs in session-scoped hooks.
 */
export default function piMlflow(pi: ExtensionAPI): void {
	// Placeholder state until session_start resolves the real config/experiment.
	// registerLifecycleHandlers reads `state` by reference on every event, so
	// mutating the fields in place (rather than reassigning) after setup keeps
	// the same object identity the handlers already closed over.
	const state = createInitialState({ trackingUri: "", experimentName: "", captureContent: false });

	registerLifecycleHandlers(pi, state);
	registerStatusCommand(pi, state);

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		// `pi-mlflow.json` lives in the project directory and is read on every
		// session_start. An untrusted project could otherwise supply a malicious
		// `trackingUri` (SSRF to an attacker-controlled host) — which alone
		// suffices to exfiltrate prompts/tool I/O now that content capture
		// defaults to on, no `captureContent` flip needed. This is the same
		// project-trust boundary pi itself applies to project-local
		// skills/extensions/resources (see `isProjectTrusted()` usages in pi's
		// resource-loader/package-manager). Only ever load config from a trusted
		// project; otherwise keep tracing disabled entirely.
		if (!ctx.isProjectTrusted()) {
			state.enabled = false;
			state.disabledReason = "project is not trusted; pi-mlflow.json is not loaded from untrusted projects";
			return;
		}

		const resolved = await setupTracing(ctx.cwd, (message) => console.warn(message));
		// Copy only the plain fields, not object identity, so this extension
		// instance's own `toolSpans` Map / span references (created fresh by
		// `createInitialState` above) are never replaced by ones shared with a
		// different extension instance via the process-global setup cache.
		state.config = resolved.config;
		state.enabled = resolved.enabled;
		state.disabledReason = resolved.disabledReason;
		state.experimentId = resolved.experimentId;
		// Git provenance is resolved fresh per trace, inside onAgentStart
		// (lifecycle.ts) using that handler's own ctx.cwd — not here.
	});
}
