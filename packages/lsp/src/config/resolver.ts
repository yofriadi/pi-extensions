import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_SERVER_CANDIDATES = [
	"typescript-language-server",
	"pyright-langserver",
	"rust-analyzer",
	"gopls",
	"clangd",
	"lua-language-server",
];

const CONFIG_FILENAMES = ["lsp.json", "lsp.yaml", "lsp.yml"];
const DEFAULT_SERVER_NAME = "default";

interface LspConfigServerFile {
	name?: string;
	command?: string | string[];
	serverCommand?: string | string[];
	server?: string;
	args?: string[];
	fileTypes?: string[];
	disabled?: boolean;
}

interface LspConfigFile {
	serverCommand?: string | string[];
	server?: string;
	args?: string[];
	serverCandidates?: string[];
	servers?: Record<string, LspConfigServerFile> | LspConfigServerFile[];
}

interface NormalizedLspServerConfig {
	name: string;
	command?: string[];
	fileTypes?: string[];
	disabled?: boolean;
}

interface NormalizedLspConfig {
	serverCommand?: string[];
	serverCandidates?: string[];
	servers?: NormalizedLspServerConfig[];
}

export interface ResolvedLspServerConfig {
	name: string;
	command: string[];
	fileTypes?: string[];
}

export interface ResolvedLspConfig {
	serverCommand: string[] | undefined;
	servers: ResolvedLspServerConfig[];
}

export interface LspConfigResolver {
	resolve(): ResolvedLspConfig;
}

export interface LspConfigResolverOptions {
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	warn?: (message: string) => void;
}

export function createLspConfigResolver(options: LspConfigResolverOptions = {}): LspConfigResolver {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? homedir();
	const env = options.env ?? process.env;
	const warn = options.warn ?? ((message: string) => console.warn(message));

	return {
		resolve(): ResolvedLspConfig {
			const userConfig = loadUserConfig(homeDir, warn);
			const projectConfig = loadConfigFromDir(join(cwd, ".pi"), warn);
			const config = mergeConfig(userConfig, projectConfig);

			const searchDirs = getSearchDirs(homeDir, env);
			const resolvedServers = resolveServers(config.servers, searchDirs, cwd, homeDir);
			if (resolvedServers.length > 0) {
				return {
					serverCommand: resolvedServers[0]?.command,
					servers: resolvedServers,
				};
			}

			const explicitCommand = resolveCommand(config.serverCommand, searchDirs, cwd, homeDir);
			if (explicitCommand) {
				return {
					serverCommand: explicitCommand,
					servers: [{ name: DEFAULT_SERVER_NAME, command: explicitCommand }],
				};
			}

			const candidates =
				config.serverCandidates && config.serverCandidates.length > 0
					? config.serverCandidates
					: DEFAULT_SERVER_CANDIDATES;

			for (const candidate of candidates) {
				const resolvedCandidate = resolveCommand([candidate], searchDirs, cwd, homeDir);
				if (resolvedCandidate) {
					return {
						serverCommand: resolvedCandidate,
						servers: [{ name: DEFAULT_SERVER_NAME, command: resolvedCandidate }],
					};
				}
			}

			return {
				serverCommand: undefined,
				servers: [],
			};
		},
	};
}

function loadUserConfig(homeDir: string, warn: (message: string) => void): NormalizedLspConfig {
	// `~/.pi/agent` is the coding-agent convention. `~/.pi` is supported as a lightweight fallback.
	const userRootConfig = loadConfigFromDir(join(homeDir, ".pi"), warn);
	const userAgentConfig = loadConfigFromDir(join(homeDir, ".pi", "agent"), warn);
	return mergeConfig(userRootConfig, userAgentConfig);
}

function loadConfigFromDir(baseDir: string, warn: (message: string) => void): NormalizedLspConfig {
	for (const filename of CONFIG_FILENAMES) {
		const filePath = join(baseDir, filename);
		if (!existsSync(filePath)) {
			continue;
		}

		const parsed = parseConfigFile(filePath, warn);
		if (parsed) {
			return normalizeConfig(parsed);
		}
	}

	return {};
}

function parseConfigFile(filePath: string, warn: (message: string) => void): LspConfigFile | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const parsed = filePath.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`Ignoring non-object LSP config in ${filePath}`);
			return undefined;
		}
		return parsed as LspConfigFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(`Failed to parse LSP config ${filePath}: ${message}`);
		return undefined;
	}
}

function normalizeConfig(config: LspConfigFile): NormalizedLspConfig {
	const normalizedServerCommand = normalizeCommand(config.serverCommand) ?? normalizeServerWithArgs(config);
	const normalizedCandidates = normalizeStringList(config.serverCandidates);
	const normalizedServers = normalizeServers(config.servers);

	return {
		serverCommand: normalizedServerCommand,
		serverCandidates: normalizedCandidates,
		servers: normalizedServers,
	};
}

function normalizeServerWithArgs(config: LspConfigFile): string[] | undefined {
	if (typeof config.server !== "string") {
		return undefined;
	}

	const server = config.server.trim();
	if (!server) {
		return undefined;
	}

	const args = normalizeStringList(config.args) ?? [];
	return [server, ...args];
}

function normalizeCommand(raw: string | string[] | undefined): string[] | undefined {
	if (typeof raw === "string") {
		const normalized = splitCommandString(raw);
		return normalized.length > 0 ? normalized : undefined;
	}

	if (!Array.isArray(raw)) {
		return undefined;
	}

	const normalized = raw.map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function splitCommandString(raw: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (char === '"' || char === "'") {
			if (!quote) {
				quote = char;
				continue;
			}
			if (quote === char) {
				quote = undefined;
				continue;
			}
		}

		if (!quote && /\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaped) {
		current += "\\";
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

function normalizeStringList(raw: string[] | undefined): string[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const normalized = raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeServers(
	raw: Record<string, LspConfigServerFile> | LspConfigServerFile[] | undefined,
): NormalizedLspServerConfig[] | undefined {
	if (!raw) {
		return undefined;
	}

	const normalized: NormalizedLspServerConfig[] = [];
	if (Array.isArray(raw)) {
		for (const [index, server] of raw.entries()) {
			const parsed = normalizeServerEntry(server, undefined, index);
			if (parsed) {
				normalized.push(parsed);
			}
		}
		return normalized.length > 0 ? normalized : undefined;
	}

	for (const [name, server] of Object.entries(raw)) {
		const parsed = normalizeServerEntry(server, name, normalized.length);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeServerEntry(
	server: LspConfigServerFile,
	nameHint: string | undefined,
	index: number,
): NormalizedLspServerConfig | undefined {
	if (!server || typeof server !== "object" || Array.isArray(server)) {
		return undefined;
	}

	const nameCandidate = typeof server.name === "string" ? server.name.trim() : "";
	const name = nameCandidate || nameHint?.trim() || `server-${index + 1}`;
	const command =
		normalizeCommand(server.command) ?? normalizeCommand(server.serverCommand) ?? normalizeServerEntryWithArgs(server);
	const fileTypes = normalizeStringList(server.fileTypes);

	return {
		name,
		command,
		fileTypes,
		disabled: typeof server.disabled === "boolean" ? server.disabled : undefined,
	};
}

function normalizeServerEntryWithArgs(server: LspConfigServerFile): string[] | undefined {
	if (typeof server.server !== "string") {
		return undefined;
	}

	const binary = server.server.trim();
	if (!binary) {
		return undefined;
	}

	const args = normalizeStringList(server.args) ?? [];
	return [binary, ...args];
}

function mergeConfig(base: NormalizedLspConfig, override: NormalizedLspConfig): NormalizedLspConfig {
	return {
		serverCommand: override.serverCommand ?? base.serverCommand,
		serverCandidates: override.serverCandidates ?? base.serverCandidates,
		servers: mergeServers(base.servers, override.servers),
	};
}

function mergeServers(
	base: NormalizedLspServerConfig[] | undefined,
	override: NormalizedLspServerConfig[] | undefined,
): NormalizedLspServerConfig[] | undefined {
	if (!base && !override) {
		return undefined;
	}

	const merged = base ? [...base] : [];
	if (!override) {
		return merged.length > 0 ? merged : undefined;
	}

	for (const entry of override) {
		const existingIndex = merged.findIndex((candidate) => candidate.name === entry.name);
		if (existingIndex === -1) {
			merged.push(entry);
			continue;
		}

		const previous = merged[existingIndex];
		merged[existingIndex] = {
			name: entry.name,
			command: entry.command ?? previous.command,
			fileTypes: entry.fileTypes ?? previous.fileTypes,
			disabled: entry.disabled ?? previous.disabled,
		};
	}

	return merged.length > 0 ? merged : undefined;
}

function resolveServers(
	servers: NormalizedLspServerConfig[] | undefined,
	searchDirs: string[],
	cwd: string,
	homeDir: string,
): ResolvedLspServerConfig[] {
	if (!servers) {
		return [];
	}

	const resolved: ResolvedLspServerConfig[] = [];
	for (const server of servers) {
		if (server.disabled === true || !server.command || server.command.length === 0) {
			continue;
		}

		const command = resolveCommand(server.command, searchDirs, cwd, homeDir);
		if (!command) {
			continue;
		}

		resolved.push({
			name: server.name,
			command,
			fileTypes: server.fileTypes,
		});
	}

	return resolved;
}

function getSearchDirs(homeDir: string, env: NodeJS.ProcessEnv): string[] {
	const pathDirs = getPathDirs(env);
	const masonDirs = getMasonDirs(homeDir, env);
	return dedupePaths([...masonDirs, ...pathDirs]);
}

function getPathDirs(env: NodeJS.ProcessEnv): string[] {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
	const pathValue = pathKey ? env[pathKey] : undefined;
	if (!pathValue) {
		return [];
	}
	return pathValue.split(delimiter).filter(Boolean);
}

function getMasonDirs(homeDir: string, env: NodeJS.ProcessEnv): string[] {
	const dirs = [
		join(homeDir, ".local", "share", "nvim", "mason", "bin"),
		join(homeDir, ".local", "share", "nvim-data", "mason", "bin"),
	];

	if (env.XDG_DATA_HOME) {
		dirs.push(join(env.XDG_DATA_HOME, "nvim", "mason", "bin"));
	}

	if (env.LOCALAPPDATA) {
		dirs.push(join(env.LOCALAPPDATA, "nvim-data", "mason", "bin"));
	}

	return dirs;
}

function dedupePaths(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	const isWindows = process.platform === "win32";

	for (const value of values) {
		const normalized = value.trim();
		if (!normalized) {
			continue;
		}
		const key = isWindows ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(normalized);
	}

	return result;
}

function resolveCommand(
	command: string[] | undefined,
	searchDirs: string[],
	cwd: string,
	homeDir: string,
): string[] | undefined {
	if (!command || command.length === 0) {
		return undefined;
	}

	const [binary, ...args] = command;
	const resolvedBinary = resolveBinary(binary, searchDirs, cwd, homeDir);
	if (!resolvedBinary) {
		return undefined;
	}

	return [resolvedBinary, ...args];
}

function resolveBinary(binary: string, searchDirs: string[], cwd: string, homeDir: string): string | undefined {
	const expandedBinary = expandHome(binary, homeDir);

	if (isPathLike(expandedBinary)) {
		const resolvedPath = isAbsolute(expandedBinary) ? expandedBinary : resolve(cwd, expandedBinary);
		return isExecutable(resolvedPath) ? resolvedPath : undefined;
	}

	for (const directory of searchDirs) {
		for (const candidateName of executableCandidates(binary)) {
			const fullPath = join(directory, candidateName);
			if (isExecutable(fullPath)) {
				return fullPath;
			}
		}
	}

	return undefined;
}

function expandHome(value: string, homeDir: string): string {
	if (value === "~") {
		return homeDir;
	}
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homeDir, value.slice(2));
	}
	return value;
}

function isPathLike(value: string): boolean {
	return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function executableCandidates(binary: string): string[] {
	if (process.platform !== "win32") {
		return [binary];
	}

	const lowerBinary = binary.toLowerCase();
	const names = [binary];
	if (!lowerBinary.endsWith(".exe")) names.push(`${binary}.exe`);
	if (!lowerBinary.endsWith(".cmd")) names.push(`${binary}.cmd`);
	if (!lowerBinary.endsWith(".bat")) names.push(`${binary}.bat`);
	return names;
}

function isExecutable(filePath: string): boolean {
	if (!existsSync(filePath)) {
		return false;
	}

	if (process.platform === "win32") {
		return true;
	}

	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
