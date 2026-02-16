import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveWebAccessProviderKeys } from "./config.js";
import { registerFetchContentTool } from "./fetch/tool.js";
import { registerWebSearchTool } from "./search/tool.js";

const STATUS_COMMANDS = ["web-status", "web-access-status"] as const;

export default function webAccessExtension(pi: ExtensionAPI): void {
	registerFetchContentTool(pi);
	registerWebSearchTool(pi);

	for (const name of STATUS_COMMANDS) {
		pi.registerCommand(name, {
			description: "Show Exa/Perplexity key availability for the web-access extension",
			handler: async (args, ctx) => {
				const explicitConfigPath = normalizeArgs(args);
				const result = resolveWebAccessProviderKeys({
					cwd: ctx.cwd,
					env: process.env,
					explicitConfigPath,
				});

				const lines = [
					"Web-access status:",
					`Exa key: ${formatStatus(result.sources.exaApiKey)}`,
					`Perplexity key: ${formatStatus(result.sources.perplexityApiKey)}`,
					`Config file: ${result.configPath ?? "not found"}`,
					"Tools: fetch_content, web_search",
				];

				if (result.warnings.length > 0) {
					lines.push(`Warnings: ${result.warnings.join(" | ")}`);
				}

				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	}
}

function normalizeArgs(args: string): string | undefined {
	const trimmed = args.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function formatStatus(source: "env" | "config" | "none"): string {
	if (source === "env") {
		return "configured via env";
	}
	if (source === "config") {
		return "configured via config";
	}
	return "missing";
}
