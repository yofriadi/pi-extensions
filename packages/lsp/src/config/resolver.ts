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

interface LspConfigFile {
	serverCommand?: string | string[];
	server?: string;
	args?: string[];
	serverCandidates?: string[];
}

interface NormalizedLspConfig {
	serverCommand?: string[];
	serverCandidates?: string[];
}

export interface ResolvedLspConfig {
	serverCommand: string[] | undefined;
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

			const explicitCommand = resolveCommand(config.serverCommand, searchDirs, cwd, homeDir);
			if (explicitCommand) {
				return { serverCommand: explicitCommand };
			}

			const candidates =
				config.serverCandidates && config.serverCandidates.length > 0
					? config.serverCandidates
					: DEFAULT_SERVER_CANDIDATES;

			for (const candidate of candidates) {
				const resolvedCandidate = resolveCommand([candidate], searchDirs, cwd, homeDir);
				if (resolvedCandidate) {
					return { serverCommand: resolvedCandidate };
				}
			}

			return { serverCommand: undefined };
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

	return {
		serverCommand: normalizedServerCommand,
		serverCandidates: normalizedCandidates,
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
		const normalized = raw.trim().split(/\s+/).filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}

	if (!Array.isArray(raw)) {
		return undefined;
	}

	const normalized = raw.map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringList(raw: string[] | undefined): string[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const normalized = raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function mergeConfig(base: NormalizedLspConfig, override: NormalizedLspConfig): NormalizedLspConfig {
	return {
		serverCommand: override.serverCommand ?? base.serverCommand,
		serverCandidates: override.serverCandidates ?? base.serverCandidates,
	};
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
