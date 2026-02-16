import { basename, extname } from "node:path";
import type { ResolvedLspConfig, ResolvedLspServerConfig } from "../config/resolver.js";
import {
	createLspClientRuntime,
	type LspClientRuntime,
	type LspClientRuntimeOptions,
	type LspDiagnostic,
} from "./runtime.js";

export interface LspRuntimeRegistryServerStatus {
	name: string;
	fileTypes?: string[];
	status: ReturnType<LspClientRuntime["getStatus"]>;
}

export interface LspRuntimeRegistryStatus {
	state: "inactive" | "starting" | "ready" | "error";
	reason: string;
	configuredServers: number;
	activeServers: number;
	servers: LspRuntimeRegistryServerStatus[];
}

export interface LspRuntimeRegistryRequestOptions {
	path?: string;
	timeoutMs?: number;
}

export interface LspRuntimeRegistry {
	start(config: ResolvedLspConfig): Promise<void>;
	stop(): Promise<void>;
	reload(config: ResolvedLspConfig): Promise<void>;
	request(method: string, params: unknown, options?: LspRuntimeRegistryRequestOptions): Promise<unknown>;
	getPublishedDiagnostics(filePath?: string): LspDiagnostic[];
	getStatus(): LspRuntimeRegistryStatus;
	getStatusForPath(filePath: string): ReturnType<LspClientRuntime["getStatus"]> | undefined;
}

export interface LspRuntimeRegistryOptions extends Omit<LspClientRuntimeOptions, "spawn"> {
	createRuntime?: () => LspClientRuntime;
}

interface RuntimeEntry {
	server: ResolvedLspServerConfig;
	runtime: LspClientRuntime;
}

export function createLspRuntimeRegistry(options: LspRuntimeRegistryOptions = {}): LspRuntimeRegistry {
	const createRuntime = options.createRuntime ?? (() => createLspClientRuntime(options));
	const entries = new Map<string, RuntimeEntry>();

	let lifecycle: LspRuntimeRegistryStatus["state"] = "inactive";
	let lifecycleReason = "LSP registry has not started.";

	return {
		async start(config: ResolvedLspConfig): Promise<void> {
			await this.stop();

			const servers = normalizeServers(config);
			if (servers.length === 0) {
				lifecycle = "inactive";
				lifecycleReason = "No LSP servers configured.";
				return;
			}

			lifecycle = "starting";
			lifecycleReason = `Starting ${servers.length} LSP server(s).`;

			for (const server of servers) {
				const runtime = createRuntime();
				entries.set(server.name, { server, runtime });
				await runtime.start(server.command);
			}

			syncLifecycle();
		},

		async stop(): Promise<void> {
			const stopPromises = [...entries.values()].map(({ runtime }) => runtime.stop());
			await Promise.allSettled(stopPromises);
			entries.clear();
			lifecycle = "inactive";
			lifecycleReason = "LSP registry stopped.";
		},

		async reload(config: ResolvedLspConfig): Promise<void> {
			await this.start(config);
		},

		async request(method: string, params: unknown, options: LspRuntimeRegistryRequestOptions = {}): Promise<unknown> {
			const entry = options.path ? selectEntryForPath(options.path) : selectWorkspaceEntry();
			if (!entry) {
				throw new Error("No LSP server is configured.");
			}
			const status = entry.runtime.getStatus();
			if (status.state !== "ready") {
				throw new Error(`LSP server ${entry.server.name} is not ready: ${status.reason}`);
			}
			return entry.runtime.request(method, params, options.timeoutMs);
		},

		getPublishedDiagnostics(filePath?: string): LspDiagnostic[] {
			if (filePath) {
				const entry = selectEntryForPath(filePath);
				return entry?.runtime.getPublishedDiagnostics(filePath) ?? [];
			}

			const diagnostics: LspDiagnostic[] = [];
			for (const { runtime } of entries.values()) {
				diagnostics.push(...runtime.getPublishedDiagnostics());
			}
			return diagnostics;
		},

		getStatus(): LspRuntimeRegistryStatus {
			syncLifecycle();
			const servers = [...entries.values()].map((entry) => ({
				name: entry.server.name,
				fileTypes: entry.server.fileTypes,
				status: entry.runtime.getStatus(),
			}));
			const activeServers = servers.filter((server) => server.status.state === "ready").length;

			return {
				state: lifecycle,
				reason: lifecycleReason,
				configuredServers: servers.length,
				activeServers,
				servers,
			};
		},

		getStatusForPath(filePath: string): ReturnType<LspClientRuntime["getStatus"]> | undefined {
			const entry = selectEntryForPath(filePath);
			return entry?.runtime.getStatus();
		},
	};

	function selectEntryForPath(filePath: string): RuntimeEntry | undefined {
		const allEntries = [...entries.values()];
		if (allEntries.length === 0) {
			return undefined;
		}

		const extension = extname(filePath).toLowerCase();
		const fileName = basename(filePath).toLowerCase();
		const exactMatches = allEntries.filter((entry) => serverMatchesFile(entry.server, extension, fileName));
		if (exactMatches.length > 0) {
			return preferReady(exactMatches);
		}

		const fallbackMatches = allEntries.filter(
			(entry) => !entry.server.fileTypes || entry.server.fileTypes.length === 0,
		);
		if (fallbackMatches.length > 0) {
			return preferReady(fallbackMatches);
		}

		return preferReady(allEntries);
	}

	function selectWorkspaceEntry(): RuntimeEntry | undefined {
		const allEntries = [...entries.values()];
		if (allEntries.length === 0) {
			return undefined;
		}
		return preferReady(allEntries);
	}

	function preferReady(candidates: RuntimeEntry[]): RuntimeEntry | undefined {
		return candidates.find((candidate) => candidate.runtime.getStatus().state === "ready") ?? candidates[0];
	}

	function syncLifecycle(): void {
		const serverStatuses = [...entries.values()].map((entry) => entry.runtime.getStatus());
		if (serverStatuses.length === 0) {
			lifecycle = "inactive";
			lifecycleReason = "No LSP servers configured.";
			return;
		}

		const active = serverStatuses.filter((status) => status.state === "ready").length;
		if (active > 0) {
			lifecycle = "ready";
			lifecycleReason = `Connected to ${active} LSP server(s).`;
			return;
		}

		if (serverStatuses.some((status) => status.state === "starting")) {
			lifecycle = "starting";
			lifecycleReason = "LSP servers are starting.";
			return;
		}

		const firstError = serverStatuses.find((status) => status.state === "error");
		if (firstError) {
			lifecycle = "error";
			lifecycleReason = firstError.reason;
			return;
		}

		lifecycle = "inactive";
		lifecycleReason = "No active LSP servers.";
	}
}

function normalizeServers(config: ResolvedLspConfig): ResolvedLspServerConfig[] {
	if (config.servers.length > 0) {
		return config.servers;
	}
	if (!config.serverCommand) {
		return [];
	}
	return [
		{
			name: "default",
			command: config.serverCommand,
		},
	];
}

function serverMatchesFile(server: ResolvedLspServerConfig, extension: string, fileName: string): boolean {
	if (!server.fileTypes || server.fileTypes.length === 0) {
		return false;
	}
	const normalized = server.fileTypes.map((value) => value.toLowerCase());
	return normalized.includes(extension) || normalized.includes(fileName);
}
