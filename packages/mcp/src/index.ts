import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { McpResolvedConfig } from "./config/mcp-config.js";
import { createMcpManager } from "./runtime/mcp-manager.js";
import { registerMcpTools } from "./tools/mcp-tools.js";

export default function mcpExtension(pi: ExtensionAPI): void {
	const manager = createMcpManager();
	const bridge = registerMcpTools(pi, manager);

	pi.on("session_start", (_event, ctx) => {
		void manager
			.startSession({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				env: process.env,
			})
			.then((state) => {
				notifyConfigDiagnostics(ctx.ui.notify, state.config);
				const bridgeSync = bridge.sync();
				notifyBridgeSync(ctx.ui.notify, bridgeSync);

				if (state.runtime.state === "error") {
					ctx.ui.notify(`MCP startup finished with errors: ${state.runtime.reason}`, "warning");
				}
			})
			.catch((error) => {
				ctx.ui.notify(`MCP startup failed: ${formatError(error)}`, "warning");
			});
	});

	pi.on("session_switch", async (_event, ctx) => {
		manager.setSessionContext({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
	});

	pi.on("session_shutdown", async () => {
		await manager.stopSession();
	});

	pi.registerCommand("mcp-reload", {
		description: "Reload MCP config files and restart MCP runtime",
		handler: async (_args, ctx) => {
			const state = await manager.reloadSession({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				env: process.env,
			});
			const bridgeSync = bridge.sync();

			notifyConfigDiagnostics(ctx.ui.notify, state.config);
			notifyBridgeSync(ctx.ui.notify, bridgeSync);
			if (state.runtime.state === "error") {
				ctx.ui.notify(`MCP runtime reloaded with errors: ${state.runtime.reason}`, "warning");
				return;
			}
			ctx.ui.notify("MCP runtime reloaded from config files.", "info");
		},
	});
}

function notifyConfigDiagnostics(
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	config: McpResolvedConfig,
): void {
	if (config.diagnostics.length === 0) {
		return;
	}
	const warningCount = config.diagnostics.filter((diag) => diag.level === "warning").length;
	const errorCount = config.diagnostics.filter((diag) => diag.level === "error").length;
	notify(
		`MCP config diagnostics: ${errorCount} error(s), ${warningCount} warning(s). Run /mcp-status for details.`,
		errorCount > 0 ? "warning" : "info",
	);
}

function notifyBridgeSync(
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	result: {
		added: number;
		total: number;
		failed: Array<{ key: string; reason: string }>;
	},
): void {
	if (result.added > 0) {
		notify(`MCP tool bridge registered ${result.added} new tool(s), total ${result.total}.`, "info");
	}
	if (result.failed.length > 0) {
		const first = result.failed[0];
		notify(
			`MCP tool bridge failed to register ${result.failed.length} tool(s). First failure: ${first.key} -> ${first.reason}`,
			"warning",
		);
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
