import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { McpManager, McpManagerState } from "../runtime/mcp-manager.js";

const BRIDGED_TOOL_NAME_MAX_LENGTH = 64;
const MAX_JSON_RESULT_CHARS = 40_000;
const FALLBACK_PARAMETERS_SCHEMA = {
	type: "object",
	additionalProperties: true,
};

interface McpDiscoveredTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpBridgedToolRegistration {
	key: string;
	server: string;
	mcpToolName: string;
	registeredName: string;
	description?: string;
}

export interface McpToolBridgeSyncResult {
	added: number;
	total: number;
	addedTools: string[];
	failed: Array<{ key: string; reason: string }>;
}

export interface McpToolBridge {
	sync(): McpToolBridgeSyncResult;
	getRegistrations(): McpBridgedToolRegistration[];
}

export function createMcpToolBridge(pi: ExtensionAPI, manager: McpManager): McpToolBridge {
	const registrationsByKey = new Map<string, McpBridgedToolRegistration>();
	const usedToolNames = new Set<string>(["mcp_call", "mcp_list_tools"]);

	return {
		sync(): McpToolBridgeSyncResult {
			const state = manager.getState();
			const addedTools: string[] = [];
			const failed: Array<{ key: string; reason: string }> = [];

			for (const [serverName, toolListState] of Object.entries(state.toolLists)) {
				if (toolListState.state !== "ready") {
					continue;
				}

				const discoveredTools = extractDiscoveredTools(toolListState.tools);
				for (const discovered of discoveredTools) {
					const key = createRegistrationKey(serverName, discovered.name);
					if (registrationsByKey.has(key)) {
						continue;
					}

					try {
						const registeredName = createStableBridgedToolName(serverName, discovered.name, usedToolNames);
						const toolDefinition = createBridgedToolDefinition({
							manager,
							serverName,
							discovered,
							registeredName,
						});
						pi.registerTool(toolDefinition);

						const registration: McpBridgedToolRegistration = {
							key,
							server: serverName,
							mcpToolName: discovered.name,
							registeredName,
							description: discovered.description,
						};
						registrationsByKey.set(key, registration);
						usedToolNames.add(registeredName);
						addedTools.push(registeredName);
					} catch (error) {
						failed.push({
							key,
							reason: formatError(error),
						});
					}
				}
			}

			return {
				added: addedTools.length,
				total: registrationsByKey.size,
				addedTools,
				failed,
			};
		},

		getRegistrations(): McpBridgedToolRegistration[] {
			return [...registrationsByKey.values()];
		},
	};
}

export function createStableBridgedToolName(
	serverName: string,
	mcpToolName: string,
	usedToolNames: Set<string>,
): string {
	const base = `mcp_${sanitizeToolNameSegment(serverName)}_${sanitizeToolNameSegment(mcpToolName)}`;
	const hashInput = `${serverName}::${mcpToolName}`;
	let candidate = trimToolName(base);

	if (!usedToolNames.has(candidate)) {
		return candidate;
	}

	const hash = shortHash(hashInput);
	candidate = trimToolName(`${base}_${hash}`);
	if (!usedToolNames.has(candidate)) {
		return candidate;
	}

	let counter = 2;
	while (usedToolNames.has(candidate)) {
		candidate = trimToolName(`${base}_${hash}_${counter}`);
		counter += 1;
	}
	return candidate;
}

export function normalizeMcpInputSchema(inputSchema: unknown): Record<string, unknown> {
	if (!isObject(inputSchema)) {
		return { ...FALLBACK_PARAMETERS_SCHEMA };
	}

	const normalized = cloneJsonObject(inputSchema);
	if (!normalized) {
		return { ...FALLBACK_PARAMETERS_SCHEMA };
	}

	const hasObjectSignals =
		normalized.type === "object" ||
		isObject(normalized.properties) ||
		Array.isArray(normalized.required) ||
		isObject(normalized.patternProperties);

	if (!hasObjectSignals) {
		return { ...FALLBACK_PARAMETERS_SCHEMA };
	}

	if (normalized.type === undefined) {
		normalized.type = "object";
	}

	if (normalized.additionalProperties === undefined) {
		normalized.additionalProperties = true;
	}

	return normalized;
}

function createBridgedToolDefinition(input: {
	manager: McpManager;
	serverName: string;
	discovered: McpDiscoveredTool;
	registeredName: string;
}): ToolDefinition {
	const { manager, serverName, discovered, registeredName } = input;
	const schema = normalizeMcpInputSchema(discovered.inputSchema);

	return {
		name: registeredName,
		label: `MCP ${discovered.name}`,
		description: discovered.description?.trim() || `Bridged MCP tool "${discovered.name}" from server "${serverName}".`,
		parameters: schema as unknown as ToolDefinition["parameters"],
		async execute(_toolCallId, params, signal) {
			const argumentsPayload = normalizeToolArguments(params);
			try {
				const result = await manager.callTool(serverName, discovered.name, argumentsPayload, {
					timeoutMs: 30_000,
					signal,
				});
				return {
					content: [
						{
							type: "text",
							text: formatJsonResult(`MCP ${serverName}.${discovered.name}`, result),
						},
					],
					details: {
						server: serverName,
						mcpToolName: discovered.name,
						registeredToolName: registeredName,
						result,
					},
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `MCP tool call failed (${serverName}.${discovered.name}): ${formatError(error)}`,
						},
					],
					details: {
						server: serverName,
						mcpToolName: discovered.name,
						registeredToolName: registeredName,
						error: formatError(error),
					},
				};
			}
		},
	};
}

function extractDiscoveredTools(tools: unknown[]): McpDiscoveredTool[] {
	const discovered: McpDiscoveredTool[] = [];
	for (const entry of tools) {
		if (!isObject(entry)) {
			continue;
		}

		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!name) {
			continue;
		}

		const description = typeof entry.description === "string" ? entry.description.trim() : undefined;
		const inputSchema = normalizeInputSchemaField(entry);
		discovered.push({
			name,
			description,
			inputSchema,
		});
	}
	return discovered;
}

function normalizeInputSchemaField(entry: Record<string, unknown>): Record<string, unknown> | undefined {
	const candidates = [entry.inputSchema, entry.input_schema, entry.parameters];
	for (const candidate of candidates) {
		if (isObject(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function normalizeToolArguments(params: unknown): Record<string, unknown> {
	if (isObject(params)) {
		return params;
	}
	if (params === undefined || params === null) {
		return {};
	}
	return { value: params };
}

function createRegistrationKey(serverName: string, mcpToolName: string): string {
	return `${serverName}::${mcpToolName}`;
}

function sanitizeToolNameSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!sanitized) {
		return "tool";
	}
	return sanitized;
}

function trimToolName(value: string): string {
	if (value.length <= BRIDGED_TOOL_NAME_MAX_LENGTH) {
		return value;
	}
	return value.slice(0, BRIDGED_TOOL_NAME_MAX_LENGTH);
}

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
	try {
		const cloned = JSON.parse(JSON.stringify(value));
		return isObject(cloned) ? cloned : undefined;
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatJsonResult(prefix: string, payload: unknown): string {
	return `${prefix}:\n${safeJsonStringify(payload, MAX_JSON_RESULT_CHARS)}`;
}

function safeJsonStringify(payload: unknown, maxChars: number): string {
	let rendered: string;
	try {
		rendered = JSON.stringify(payload, null, 2) ?? "";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		rendered = `"<unserializable payload: ${message}>"`;
	}

	if (rendered.length <= maxChars) {
		return rendered;
	}
	return `${rendered.slice(0, maxChars)}\n... (truncated at ${maxChars} chars)`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function getMcpBridgeToolSummary(state: McpManagerState): { readyServers: number; discoveredTools: number } {
	let readyServers = 0;
	let discoveredTools = 0;
	for (const toolListState of Object.values(state.toolLists)) {
		if (toolListState.state !== "ready") {
			continue;
		}
		readyServers += 1;
		discoveredTools += extractDiscoveredTools(toolListState.tools).length;
	}
	return { readyServers, discoveredTools };
}
