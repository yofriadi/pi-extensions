import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CONFIG_FILENAME = "web-access.json";
const EXA_ENV_KEYS = ["EXA_API_KEY", "PI_EXA_API_KEY"] as const;
const PERPLEXITY_ENV_KEYS = ["PERPLEXITY_API_KEY", "PI_PERPLEXITY_API_KEY"] as const;

type KeySource = "env" | "config" | "none";

export interface WebAccessProviderKeys {
	exaApiKey?: string;
	perplexityApiKey?: string;
}

export interface WebAccessConfigLoadOptions {
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	explicitConfigPath?: string;
	warn?: (message: string) => void;
}

export interface ResolvedWebAccessProviderKeys extends WebAccessProviderKeys {
	sources: {
		exaApiKey: KeySource;
		perplexityApiKey: KeySource;
	};
	configPath?: string;
	warnings: string[];
}

interface WebAccessConfigFile {
	exaApiKey?: unknown;
	perplexityApiKey?: unknown;
	exa?: unknown;
	perplexity?: unknown;
}

interface ConfigLoadResult {
	keys: WebAccessProviderKeys;
	configPath?: string;
}

interface ConfigLoadOptions {
	cwd: string;
	homeDir: string;
	explicitConfigPath?: string;
	warn: (message: string) => void;
}

export function loadWebAccessProviderKeys(options: WebAccessConfigLoadOptions = {}): WebAccessProviderKeys {
	const result = resolveWebAccessProviderKeys(options);
	return {
		exaApiKey: result.exaApiKey,
		perplexityApiKey: result.perplexityApiKey,
	};
}

export function resolveWebAccessProviderKeys(options: WebAccessConfigLoadOptions = {}): ResolvedWebAccessProviderKeys {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? homedir();
	const env = options.env ?? process.env;

	const warnings: string[] = [];
	const warn = options.warn ?? ((message: string) => warnings.push(message));

	const configResult = loadConfigKeys({
		cwd,
		homeDir,
		explicitConfigPath: options.explicitConfigPath,
		warn,
	});

	const exaEnvKey = pickFirstEnvValue(env, EXA_ENV_KEYS);
	const perplexityEnvKey = pickFirstEnvValue(env, PERPLEXITY_ENV_KEYS);

	const exaApiKey = exaEnvKey ?? configResult.keys.exaApiKey;
	const perplexityApiKey = perplexityEnvKey ?? configResult.keys.perplexityApiKey;

	return {
		exaApiKey,
		perplexityApiKey,
		sources: {
			exaApiKey: exaEnvKey ? "env" : configResult.keys.exaApiKey ? "config" : "none",
			perplexityApiKey: perplexityEnvKey ? "env" : configResult.keys.perplexityApiKey ? "config" : "none",
		},
		configPath: configResult.configPath,
		warnings,
	};
}

function loadConfigKeys(options: ConfigLoadOptions): ConfigLoadResult {
	const keys: WebAccessProviderKeys = {};
	let configPath: string | undefined;

	for (const candidatePath of getConfigCandidates(options.cwd, options.homeDir, options.explicitConfigPath)) {
		if (!existsSync(candidatePath)) {
			continue;
		}

		const parsed = parseConfigFile(candidatePath, options.warn);
		if (!parsed) {
			continue;
		}

		const normalized = normalizeConfig(parsed);
		if (normalized.exaApiKey) {
			keys.exaApiKey = normalized.exaApiKey;
		}
		if (normalized.perplexityApiKey) {
			keys.perplexityApiKey = normalized.perplexityApiKey;
		}
		configPath = candidatePath;
	}

	return { keys, configPath };
}

function getConfigCandidates(cwd: string, homeDir: string, explicitConfigPath?: string): string[] {
	const candidates = [
		join(homeDir, ".pi", CONFIG_FILENAME),
		join(homeDir, ".pi", "agent", CONFIG_FILENAME),
		join(cwd, ".pi", CONFIG_FILENAME),
	];

	if (explicitConfigPath) {
		candidates.push(resolvePath(explicitConfigPath, cwd));
	}

	return dedupe(candidates);
}

function parseConfigFile(filePath: string, warn: (message: string) => void): WebAccessConfigFile | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		if (!isObject(parsed)) {
			warn(`Ignoring non-object web-access config in ${filePath}`);
			return undefined;
		}
		return parsed as WebAccessConfigFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(`Failed to parse web-access config ${filePath}: ${message}`);
		return undefined;
	}
}

function normalizeConfig(config: WebAccessConfigFile): WebAccessProviderKeys {
	const exaNested = isObject(config.exa) ? config.exa.apiKey : undefined;
	const perplexityNested = isObject(config.perplexity) ? config.perplexity.apiKey : undefined;

	return {
		exaApiKey: normalizeApiKey(config.exaApiKey ?? exaNested),
		perplexityApiKey: normalizeApiKey(config.perplexityApiKey ?? perplexityNested),
	};
}

function resolvePath(inputPath: string, cwd: string): string {
	return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

function normalizeApiKey(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function pickFirstEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = normalizeApiKey(env[key]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		deduped.push(value);
	}
	return deduped;
}
