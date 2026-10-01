import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { redactTrackingUri } from "./auth.ts";
import { SERVER_WAIT_GRACE_MS } from "./constants.ts";
import type { TracingState } from "./state.ts";

/**
 * Registers `/mlflow`, showing tracking URI, resolved experiment,
 * capture-content mode, and current status (active, or disabled + reason).
 * While active it may add one degraded-flush line when the most recent flush
 * wait exceeded `SERVER_WAIT_GRACE_MS`: the status line stays `active`, and
 * the degraded line is never rendered while tracing is disabled. Never
 * displays captured trace content — only configuration/status fields, per the
 * mlflow-status-command spec. Tracking URIs with embedded userinfo are
 * redacted so credentials never appear in the TUI.
 */
export function registerStatusCommand(pi: ExtensionAPI, state: TracingState): void {
	pi.registerCommand("mlflow", {
		description:
			"Show pi-mlflow tracing configuration and status (capture content controls Sessions conversation text and child span bodies)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = buildStatusLines(state);
			ctx.ui.notify(lines.join("\n"), state.enabled ? "info" : "warning");
		},
	});
}

export function buildStatusLines(state: TracingState): string[] {
	const lines: string[] = ["pi-mlflow status:"];
	const trackingUri = state.config.trackingUri ? redactTrackingUri(state.config.trackingUri) : "(none)";
	lines.push(`  tracking URI: ${trackingUri}`);
	lines.push(
		`  experiment: ${state.config.experimentName || "(none)"}${state.experimentId ? ` (id: ${state.experimentId})` : ""}`,
	);
	lines.push(
		`  capture content: ${state.config.captureContent ? "enabled" : "disabled"} (Sessions conversation text + child span bodies)`,
	);

	if (state.enabled) {
		lines.push("  status: active");
		if (state.flushWaitExceeded) {
			// Degraded-but-active: the last flush wait outlived the grace period
			// and the extension stopped waiting on it. The export was never
			// cancelled and continues in the background, so the `status: active`
			// line above stays accurate — this reports a bounded wait being hit,
			// not tracing being disabled. Config/status only, never trace content.
			lines.push(
				`  last flush wait exceeded the ${SERVER_WAIT_GRACE_MS}ms bound (export continuing in background)`,
			);
		}
	} else {
		// Per D9/mlflow-status-command spec: never show stale "active"-style
		// fields (e.g. last flush) when disabled — just status + reason.
		lines.push(`  status: disabled (${state.disabledReason ?? "unknown reason"})`);
	}

	return lines;
}
