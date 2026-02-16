import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DISCOVERY_ADAPTERS_ENV_KEY = "PI_MCP_DISCOVERY_ADAPTERS";

export type McpTransport = "stdio" | "http";
export type McpDiscoveryAdapter = "claude" | "cursor";

export interface McpServerConfig {
	name: string;
	transport: McpTransport;
	command?: string;
	args: string[];
	url?: string;
	headers: Record<string, string>;
	env: Record<string, string>;
	timeoutMs: number;
	disabled: boolean;
	sourcePath: string;
}

export interface McpConfigDiagnostic {
	level: "warning" | "error";
	code: string;
	message: string;
	sourcePath?: string;
	serverName?: string;
}

export interface McpResolvedConfig {
	servers: McpServerConfig[];
	diagnostics: McpConfigDiagnostic[];
	sourcePaths: string[];
}

export interface McpConfigResolverOptions {
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	explicitConfigPath?: string;
	discoveryAdapters?: McpDiscoveryAdapter[];
	warn?: (diagnostic: McpConfigDiagnostic) => void;
}

export interface McpConfigResolver {
	resolve(explicitConfigPath?: string): McpResolvedConfig;
}

type JsonObject = Record<string, unknown>;

type RawServerEntry = {
	name: string;
	value: unknown;
};

interface ConfigSourceCandidate {
	path: string;
	adapter?: McpDiscoveryAdapter;
}

export function createMcpConfigResolver(options: McpConfigResolverOptions = {}): McpConfigResolver {
	return {
		resolve(explicitConfigPath?: string): McpResolvedConfig {
			const cwd = options.cwd ?? process.cwd();
			const homeDir = options.homeDir ?? homedir();
			const diagnostics: McpConfigDiagnostic[] = [];
			const warn = options.warn ?? ((diagnostic: McpConfigDiagnostic) => diagnostics.push(diagnostic));
			const sourcePaths: string[] = [];
			const serversByName = new Map<string, McpServerConfig>();
			const resolvedExplicit = explicitConfigPath ?? options.explicitConfigPath;
			const discoveryAdapters = resolveDiscoveryAdapters(options.discoveryAdapters, options.env ?? process.env, warn);

			for (const source of getCandidateSources(cwd, homeDir, resolvedExplicit, discoveryAdapters)) {
				if (!existsSync(source.path)) {
					continue;
				}

				sourcePaths.push(source.path);
				const rawConfig = parseJsonFile(source.path, warn);
				if (!rawConfig) {
					continue;
				}

				const configObjects =
					source.adapter === undefined ? [rawConfig] : extractAdapterConfigObjects(rawConfig, source.adapter, cwd);

				for (const configObject of configObjects) {
					for (const entry of extractServerEntries(configObject, source.path, warn)) {
						const parsed = parseServerConfig(entry, source.path, warn);
						if (!parsed) {
							continue;
						}
						if (parsed.disabled) {
							serversByName.delete(parsed.name);
							continue;
						}
						serversByName.set(parsed.name, parsed);
					}
				}
			}

			return {
				servers: [...serversByName.values()],
				diagnostics,
				sourcePaths,
			};
		},
	};
}

export function createMcpConfig(options: McpConfigResolverOptions = {}): McpResolvedConfig {
	return createMcpConfigResolver(options).resolve();
}

function getCandidateSources(
	cwd: string,
	homeDir: string,
	explicitConfigPath: string | undefined,
	discoveryAdapters: McpDiscoveryAdapter[],
): ConfigSourceCandidate[] {
	const nativeCandidates: ConfigSourceCandidate[] = [
		{ path: join(homeDir, ".pi", "agent", "mcp.json") },
		{ path: join(cwd, ".mcp.json") },
		{ path: join(cwd, ".pi", "mcp.json") },
	];
	const adapterCandidates = getAdapterCandidates(cwd, homeDir, discoveryAdapters);
	const explicitCandidates = explicitConfigPath?.trim() ? [{ path: resolveConfigPath(explicitConfigPath, cwd) }] : [];

	return dedupeCandidates([...adapterCandidates, ...nativeCandidates, ...explicitCandidates]);
}

function getAdapterCandidates(
	cwd: string,
	homeDir: string,
	discoveryAdapters: McpDiscoveryAdapter[],
): ConfigSourceCandidate[] {
	const candidates: ConfigSourceCandidate[] = [];
	for (const adapter of discoveryAdapters) {
		if (adapter === "claude") {
			candidates.push(
				{ path: join(homeDir, ".claude.json"), adapter },
				{ path: join(homeDir, ".config", "claude", "claude_desktop_config.json"), adapter },
				{ path: join(cwd, ".claude.json"), adapter },
			);
			continue;
		}

		if (adapter === "cursor") {
			candidates.push(
				{ path: join(homeDir, ".cursor", "mcp.json"), adapter },
				{ path: join(cwd, ".cursor", "mcp.json"), adapter },
				{ path: join(cwd, ".vscode", "mcp.json"), adapter },
			);
		}
	}
	return candidates;
}

function dedupeCandidates(candidates: ConfigSourceCandidate[]): ConfigSourceCandidate[] {
	const unique = new Map<string, ConfigSourceCandidate>();
	for (const candidate of candidates) {
		if (!unique.has(candidate.path)) {
			unique.set(candidate.path, candidate);
		}
	}
	return [...unique.values()];
}

function resolveDiscoveryAdapters(
	explicitAdapters: McpDiscoveryAdapter[] | undefined,
	env: NodeJS.ProcessEnv,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): McpDiscoveryAdapter[] {
	const raw =
		explicitAdapters ??
		(env[DISCOVERY_ADAPTERS_ENV_KEY]
			? env[DISCOVERY_ADAPTERS_ENV_KEY]
					.split(",")
					.map((entry) => entry.trim().toLowerCase())
					.filter((entry) => entry.length > 0)
			: []);

	const normalized = new Set<McpDiscoveryAdapter>();
	for (const entry of raw) {
		const value = typeof entry === "string" ? entry.trim().toLowerCase() : "";
		if (!value || value === "none") {
			continue;
		}
		if (value === "claude" || value === "cursor") {
			normalized.add(value);
			continue;
		}
		warn({
			level: "warning",
			code: "discovery_adapter_unknown",
			message: `Ignoring unknown MCP discovery adapter "${entry}". Supported values: claude,cursor.`,
		});
	}

	return [...normalized];
}

function extractAdapterConfigObjects(rawConfig: JsonObject, adapter: McpDiscoveryAdapter, cwd: string): JsonObject[] {
	const objects: JsonObject[] = [rawConfig];
	const nested = adapter === "claude" ? rawConfig.projects : (rawConfig.workspaces ?? rawConfig.projects);
	if (!isObject(nested)) {
		return objects;
	}

	for (const [projectPath, projectConfig] of Object.entries(nested)) {
		if (!isObject(projectConfig)) {
			continue;
		}
		if (!pathMatchesCwd(projectPath, cwd)) {
			continue;
		}
		objects.push(projectConfig);
	}

	return objects;
}

function pathMatchesCwd(configPath: string, cwd: string): boolean {
	const resolvedConfig = resolve(configPath);
	const resolvedCwd = resolve(cwd);

	if (resolvedConfig === resolvedCwd) {
		return true;
	}

	const relation = relative(resolvedConfig, resolvedCwd);
	if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
		return false;
	}

	return true;
}

function resolveConfigPath(inputPath: string, cwd: string): string {
	return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

function parseJsonFile(sourcePath: string, warn: (diagnostic: McpConfigDiagnostic) => void): JsonObject | undefined {
	try {
		const content = readFileSync(sourcePath, "utf8");
		const parsed = JSON.parse(content);
		if (!isObject(parsed)) {
			warn({
				level: "warning",
				code: "config_not_object",
				message: "Ignoring MCP config because top-level JSON value is not an object.",
				sourcePath,
			});
			return undefined;
		}
		return parsed;
	} catch (error) {
		warn({
			level: "error",
			code: "config_parse_failed",
			message: `Failed to parse MCP config: ${formatError(error)}`,
			sourcePath,
		});
		return undefined;
	}
}

function extractServerEntries(
	rawConfig: JsonObject,
	sourcePath: string,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): RawServerEntry[] {
	const entries: RawServerEntry[] = [];

	const objectShapes: Array<[string, unknown]> = [
		["mcpServers", rawConfig.mcpServers],
		["servers", rawConfig.servers],
	];

	for (const [key, value] of objectShapes) {
		if (value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const candidate of value) {
				if (!isObject(candidate)) {
					warn({
						level: "warning",
						code: "server_entry_invalid",
						message: `Ignoring ${key} entry because it is not an object.`,
						sourcePath,
					});
					continue;
				}
				const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
				if (!name) {
					warn({
						level: "warning",
						code: "server_name_missing",
						message: `Ignoring ${key} entry because "name" is missing.`,
						sourcePath,
					});
					continue;
				}
				entries.push({ name, value: candidate });
			}
			continue;
		}

		if (isObject(value)) {
			for (const [name, entry] of Object.entries(value)) {
				entries.push({ name, value: entry });
			}
			continue;
		}

		warn({
			level: "warning",
			code: "server_shape_invalid",
			message: `Ignoring ${key} because expected object or array but got ${typeof value}.`,
			sourcePath,
		});
	}

	return entries;
}

function parseServerConfig(
	entry: RawServerEntry,
	sourcePath: string,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): McpServerConfig | undefined {
	if (!isObject(entry.value)) {
		warn({
			level: "warning",
			code: "server_entry_not_object",
			message: `Ignoring server "${entry.name}" because its value is not an object.`,
			sourcePath,
			serverName: entry.name,
		});
		return undefined;
	}

	const raw = entry.value;
	const transport = normalizeTransport(raw.transport, raw.command, raw.url);
	const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : undefined;
	const args = normalizeStringArray(raw.args, "args", entry.name, sourcePath, warn);
	const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined;
	const headers = normalizeStringMap(raw.headers, "headers", entry.name, sourcePath, warn);
	const env = normalizeStringMap(raw.env, "env", entry.name, sourcePath, warn);
	const timeoutMs = normalizeTimeout(raw.timeoutMs, sourcePath, entry.name, warn);
	const disabled = Boolean(raw.disabled);

	if (transport === "stdio" && !command) {
		warn({
			level: "error",
			code: "stdio_command_missing",
			message: `Ignoring server "${entry.name}" because transport is stdio but "command" is missing.`,
			sourcePath,
			serverName: entry.name,
		});
		return undefined;
	}

	if (transport === "http") {
		if (!url) {
			warn({
				level: "error",
				code: "http_url_missing",
				message: `Ignoring server "${entry.name}" because transport is http but "url" is missing.`,
				sourcePath,
				serverName: entry.name,
			});
			return undefined;
		}
		if (!isHttpUrl(url)) {
			warn({
				level: "error",
				code: "http_url_invalid",
				message: `Ignoring server "${entry.name}" because url is not a valid http(s) URL: ${url}`,
				sourcePath,
				serverName: entry.name,
			});
			return undefined;
		}
	}

	return {
		name: entry.name,
		transport,
		command,
		args,
		url,
		headers,
		env,
		timeoutMs,
		disabled,
		sourcePath,
	};
}

function normalizeTransport(transport: unknown, command: unknown, url: unknown): McpTransport {
	if (transport === "http" || transport === "stdio") {
		return transport;
	}
	if (typeof url === "string" && url.trim()) {
		return "http";
	}
	if (typeof command === "string" && command.trim()) {
		return "stdio";
	}
	return "stdio";
}

function normalizeStringArray(
	value: unknown,
	key: string,
	serverName: string,
	sourcePath: string,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		warn({
			level: "warning",
			code: "string_array_invalid",
			message: `Ignoring "${key}" for server "${serverName}" because it is not an array.`,
			sourcePath,
			serverName,
		});
		return [];
	}
	return value
		.filter((item) => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function normalizeStringMap(
	value: unknown,
	key: string,
	serverName: string,
	sourcePath: string,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isObject(value)) {
		warn({
			level: "warning",
			code: "string_map_invalid",
			message: `Ignoring "${key}" for server "${serverName}" because it is not an object.`,
			sourcePath,
			serverName,
		});
		return {};
	}

	const output: Record<string, string> = {};
	for (const [mapKey, mapValue] of Object.entries(value)) {
		if (typeof mapValue !== "string") {
			warn({
				level: "warning",
				code: "string_map_value_invalid",
				message: `Ignoring non-string value for "${key}.${mapKey}" on server "${serverName}".`,
				sourcePath,
				serverName,
			});
			continue;
		}
		const trimmed = mapValue.trim();
		if (!trimmed) {
			continue;
		}
		output[mapKey] = trimmed;
	}

	return output;
}

function normalizeTimeout(
	value: unknown,
	sourcePath: string,
	serverName: string,
	warn: (diagnostic: McpConfigDiagnostic) => void,
): number {
	if (value === undefined) {
		return DEFAULT_TIMEOUT_MS;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		warn({
			level: "warning",
			code: "timeout_invalid",
			message: `Ignoring timeoutMs for server "${serverName}" because it is not a positive number.`,
			sourcePath,
			serverName,
		});
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.round(value);
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
