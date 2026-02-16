import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLspClientRuntime } from "./client/runtime.js";
import { createLspConfigResolver } from "./config/resolver.js";
import { createWriteThroughHooks } from "./hooks/writethrough.js";
import { createLspToolRouter } from "./tools/lsp-tool.js";

export default function lspExtension(pi: ExtensionAPI): void {
	const runtime = createLspClientRuntime();
	const configResolver = createLspConfigResolver();
	const toolRouter = createLspToolRouter(runtime, {
		getServerCommand: () => configResolver.resolve().serverCommand,
	});
	const writeThroughHooks = createWriteThroughHooks(runtime);

	toolRouter.register(pi);
	writeThroughHooks.register(pi);

	pi.on("session_start", async (_event, ctx) => {
		const config = configResolver.resolve();
		await runtime.start(config.serverCommand);
		const status = runtime.getStatus();
		if (status.state === "error") {
			ctx.ui.notify(`LSP startup failed: ${status.reason}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await runtime.stop();
	});

	pi.registerCommand("lsp-status", {
		description: "Show health information for the LSP extension scaffold",
		handler: async (_args, ctx) => {
			const config = configResolver.resolve();
			const status = runtime.getStatus();
			const configured = config.serverCommand?.join(" ") ?? "not configured";
			const active = status.activeCommand?.join(" ") ?? "not running";
			const transport = status.transport ?? "n/a";
			const fallback = status.fallbackReason ? ` fallback: ${status.fallbackReason}` : "";

			ctx.ui.notify(
				`LSP ${status.state} via ${transport}; configured: ${configured}; active: ${active}; reason: ${status.reason}${fallback}`,
				status.state === "error" ? "warning" : "info",
			);
		},
	});
}
