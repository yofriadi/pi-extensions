import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLspRuntimeRegistry } from "./client/registry.js";
import { createLspConfigResolver } from "./config/resolver.js";
import { createWriteThroughHooks } from "./hooks/writethrough.js";
import { createLspToolRouter } from "./tools/lsp-tool.js";

export default function lspExtension(pi: ExtensionAPI): void {
	const runtime = createLspRuntimeRegistry();
	const configResolver = createLspConfigResolver();
	const toolRouter = createLspToolRouter(runtime, {
		getResolvedConfig: () => configResolver.resolve(),
	});
	const writeThroughHooks = createWriteThroughHooks(runtime);

	toolRouter.register(pi);
	writeThroughHooks.register(pi);

	pi.on("session_start", async (_event, ctx) => {
		const config = configResolver.resolve();
		await runtime.start(config);
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
			const status = runtime.getStatus();
			const lines = [
				`LSP registry: ${status.state}`,
				`Reason: ${status.reason}`,
				`Configured servers: ${status.configuredServers}`,
				`Active servers: ${status.activeServers}`,
			];

			if (status.servers.length > 0) {
				lines.push("Servers:");
				for (const server of status.servers) {
					const command =
						server.status.activeCommand?.join(" ") ?? server.status.configuredCommand?.join(" ") ?? "not configured";
					const fileTypes = server.fileTypes && server.fileTypes.length > 0 ? server.fileTypes.join(",") : "*";
					lines.push(
						`- ${server.name} [${fileTypes}] -> ${server.status.state}; transport=${server.status.transport ?? "n/a"}; command=${command}; reason=${server.status.reason}`,
					);
				}
			}

			ctx.ui.notify(lines.join("\n"), status.state === "error" ? "warning" : "info");
		},
	});
}
