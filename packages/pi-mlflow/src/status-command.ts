import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { redactTrackingUri } from "./auth.ts";
import type { TracingState } from "./state.ts";

/**
 * Registers `/mlflow`, showing tracking URI, resolved experiment, capture-content
 * mode, and current status (active, or disabled + reason). Never displays
 * captured trace content — only configuration/status fields, per the
 * mlflow-status-command spec. Tracking URIs with embedded userinfo are redacted
 * so credentials never appear in the TUI.
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
	} else {
		// Per D9/mlflow-status-command spec: never show stale "active"-style
		// fields (e.g. last flush) when disabled — just status + reason.
		lines.push(`  status: disabled (${state.disabledReason ?? "unknown reason"})`);
	}

	return lines;
}
