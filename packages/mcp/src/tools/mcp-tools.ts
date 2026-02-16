import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { McpManager } from "../runtime/mcp-manager.js";
import { createMcpToolBridge, getMcpBridgeToolSummary, type McpToolBridge } from "./mcp-tool-bridge.js";

const MCP_CALL_PARAMS = Type.Object({
	server: Type.String({ description: "Configured MCP server name" }),
	method: Type.String({ description: "JSON-RPC method name" }),
	params: Type.Optional(Type.Unknown({ description: "JSON-RPC params payload" })),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
});

const MCP_LIST_TOOLS_PARAMS = Type.Object({
	server: Type.String({ description: "Configured MCP server name" }),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
});

export function registerMcpTools(pi: ExtensionAPI, manager: McpManager): McpToolBridge {
	const bridge = createMcpToolBridge(pi, manager);

	pi.registerCommand("mcp-status", {
		description: "Show status information for configured MCP servers",
		handler: async (_args, ctx) => {
			const state = manager.getState();
			const config = state.config;
			const status = state.runtime;
			const bridgeSummary = getMcpBridgeToolSummary(state);
			const lines = [
				`MCP manager: ${state.lifecycle} (${state.reason})`,
				`MCP state: ${status.state}`,
				`Reason: ${status.reason}`,
				`Configured servers: ${status.configuredServers}`,
				`Active servers: ${status.activeServers}`,
				`Discovered MCP tools: ${bridgeSummary.discoveredTools} across ${bridgeSummary.readyServers} ready server(s)`,
				`Bridged MCP tools: ${bridge.getRegistrations().length}`,
			];

			if (state.session) {
				const sessionLabel = state.session.sessionId ?? "<none>";
				const activeLabel = state.session.isActive ? "active" : "inactive";
				lines.push(`Session: ${sessionLabel} (${activeLabel}, reloads: ${state.session.reloadCount})`);
			}

			if (status.servers.length > 0) {
				lines.push("Servers:");
				for (const server of status.servers) {
					const location =
						server.transport === "http"
							? (server.url ?? "<missing url>")
							: (server.command?.join(" ") ?? "<missing command>");
					lines.push(`- ${server.name}: ${server.state} (${server.transport}) ${location} -> ${server.reason}`);
				}
			}

			const toolLists = Object.values(state.toolLists);
			if (toolLists.length > 0) {
				lines.push("Tool list cache:");
				for (const entry of toolLists) {
					lines.push(`- ${entry.server}: ${entry.state} (${entry.tools.length} tool(s)) -> ${entry.reason}`);
				}
			}

			if (config.diagnostics.length > 0) {
				lines.push("Diagnostics:");
				for (const diagnostic of config.diagnostics) {
					lines.push(`- ${diagnostic.level} ${diagnostic.code}: ${diagnostic.message}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), status.state === "error" ? "warning" : "info");
		},
	});

	pi.registerCommand("mcp-tools", {
		description: "List tools exposed by a configured MCP server (/mcp-tools <server>)",
		handler: async (args, ctx) => {
			const server = args.trim();
			if (!server) {
				ctx.ui.notify("Usage: /mcp-tools <server>", "warning");
				return;
			}

			try {
				const result = await manager.listTools(server, { timeoutMs: 20_000 });
				ctx.ui.notify(formatJsonResult(`MCP tools for ${server}`, result), "info");
			} catch (error) {
				ctx.ui.notify(`Failed to list MCP tools for ${server}: ${formatError(error)}`, "warning");
			}
		},
	});

	pi.registerCommand("mcp-call", {
		description: "Call an MCP method (/mcp-call <server> <method> [jsonParams])",
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /mcp-call <server> <method> [jsonParams]", "warning");
				return;
			}

			try {
				const result = await manager.request(parsed.server, parsed.method, parsed.params ?? {}, {
					timeoutMs: 25_000,
				});
				ctx.ui.notify(formatJsonResult(`MCP result ${parsed.server}.${parsed.method}`, result), "info");
			} catch (error) {
				ctx.ui.notify(`MCP request failed: ${formatError(error)}`, "warning");
			}
		},
	});

	pi.registerTool({
		name: "mcp_call",
		label: "MCP call",
		description: "Call a JSON-RPC method on a configured MCP server",
		parameters: MCP_CALL_PARAMS,
		async execute(_toolCallId, params, signal) {
			try {
				const result = await manager.request(params.server, params.method, params.params ?? {}, {
					timeoutMs: params.timeoutMs,
					signal,
				});
				return {
					content: [
						{
							type: "text",
							text: formatJsonResult(`MCP ${params.server}.${params.method}`, result),
						},
					],
					details: {
						server: params.server,
						method: params.method,
						result,
						error: undefined as string | undefined,
					},
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `MCP request failed: ${formatError(error)}`,
						},
					],
					details: {
						server: params.server,
						method: params.method,
						result: undefined,
						error: formatError(error),
					},
				};
			}
		},
	});

	pi.registerTool({
		name: "mcp_list_tools",
		label: "MCP list tools",
		description: "List tools exposed by a configured MCP server",
		parameters: MCP_LIST_TOOLS_PARAMS,
		async execute(_toolCallId, params, signal) {
			try {
				const result = await manager.listTools(params.server, {
					timeoutMs: params.timeoutMs,
					signal,
				});
				return {
					content: [
						{
							type: "text",
							text: formatJsonResult(`MCP tools ${params.server}`, result),
						},
					],
					details: {
						server: params.server,
						result,
						error: undefined as string | undefined,
					},
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Failed to list MCP tools for ${params.server}: ${formatError(error)}`,
						},
					],
					details: {
						server: params.server,
						result: undefined,
						error: formatError(error),
					},
				};
			}
		},
	});

	return bridge;
}

function parseCommandArgs(input: string): { server: string; method: string; params?: unknown } | undefined {
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}

	const firstSpace = trimmed.indexOf(" ");
	if (firstSpace === -1) {
		return undefined;
	}
	const server = trimmed.slice(0, firstSpace).trim();
	const rest = trimmed.slice(firstSpace + 1).trim();
	if (!server || !rest) {
		return undefined;
	}

	const secondSpace = rest.indexOf(" ");
	if (secondSpace === -1) {
		return {
			server,
			method: rest,
		};
	}

	const method = rest.slice(0, secondSpace).trim();
	const paramsRaw = rest.slice(secondSpace + 1).trim();
	if (!method) {
		return undefined;
	}

	if (!paramsRaw) {
		return { server, method };
	}

	try {
		return {
			server,
			method,
			params: JSON.parse(paramsRaw),
		};
	} catch {
		return {
			server,
			method,
			params: paramsRaw,
		};
	}
}

function formatJsonResult(prefix: string, payload: unknown): string {
	return `${prefix}:\n${JSON.stringify(payload, null, 2)}`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
