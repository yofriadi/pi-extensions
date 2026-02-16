import { createMcpConfigResolver, type McpResolvedConfig } from "../config/mcp-config.js";
import { createMcpRuntime, type McpRequestOptions, type McpRuntime, type McpRuntimeStatus } from "./mcp-runtime.js";

export type McpManagerLifecycleState = "inactive" | "starting" | "ready" | "stopping" | "error";

export interface McpManagerSessionContext {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	env?: NodeJS.ProcessEnv;
	explicitConfigPath?: string;
}

export interface McpManagerSessionState {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	startedAt: string;
	lastReloadAt?: string;
	stoppedAt?: string;
	reloadCount: number;
	isActive: boolean;
}

export interface McpManagerToolListState {
	server: string;
	state: "ready" | "error" | "stale";
	reason: string;
	refreshedAt?: string;
	tools: unknown[];
}

export interface McpManagerState {
	lifecycle: McpManagerLifecycleState;
	reason: string;
	session?: McpManagerSessionState;
	config: McpResolvedConfig;
	runtime: McpRuntimeStatus;
	toolLists: Record<string, McpManagerToolListState>;
}

export interface McpManager {
	startSession(context: McpManagerSessionContext): Promise<McpManagerState>;
	stopSession(): Promise<McpManagerState>;
	reloadSession(context: McpManagerSessionContext): Promise<McpManagerState>;
	refreshToolLists(serverNames?: string[]): Promise<McpManagerState>;
	setSessionContext(context: McpManagerSessionContext): McpManagerState;
	request(serverName: string, method: string, params?: unknown, options?: McpRequestOptions): Promise<unknown>;
	listTools(serverName: string, options?: McpRequestOptions): Promise<unknown>;
	callTool(serverName: string, toolName: string, args?: unknown, options?: McpRequestOptions): Promise<unknown>;
	getState(): McpManagerState;
}

interface McpManagerOptions {
	runtime?: McpRuntime;
	resolveConfig?: (context: McpManagerSessionContext) => McpResolvedConfig;
	now?: () => Date;
}

const DEFAULT_TOOL_REFRESH_TIMEOUT_MS = 20_000;
const EMPTY_CONFIG: McpResolvedConfig = {
	servers: [],
	diagnostics: [],
	sourcePaths: [],
};

export function createMcpManager(options: McpManagerOptions = {}): McpManager {
	const runtime = options.runtime ?? createMcpRuntime();
	const now = options.now ?? (() => new Date());
	const resolveConfig =
		options.resolveConfig ??
		((context: McpManagerSessionContext) =>
			createMcpConfigResolver({
				cwd: context.cwd,
				env: context.env ?? process.env,
			}).resolve(context.explicitConfigPath));

	let lifecycle: McpManagerLifecycleState = "inactive";
	let lifecycleReason = "not started";
	let currentConfig: McpResolvedConfig = cloneResolvedConfig(EMPTY_CONFIG);
	let sessionState: McpManagerSessionState | undefined;
	const toolLists = new Map<string, McpManagerToolListState>();
	let lifecycleQueue = Promise.resolve();

	const manager: McpManager = {
		async startSession(context: McpManagerSessionContext): Promise<McpManagerState> {
			return runSerialized(async () => {
				lifecycle = "starting";
				lifecycleReason = "starting MCP manager";
				upsertSession(context, false);

				try {
					const resolved = resolveConfig(context);
					currentConfig = cloneResolvedConfig(resolved);
					await runtime.start(resolved);
					await refreshToolListsInternal();
					syncLifecycleFromRuntime();
				} catch (error) {
					await runtime.stop().catch(() => undefined);
					lifecycle = "error";
					lifecycleReason = `startup failed: ${formatError(error)}`;
					markSessionStopped();
					toolLists.clear();
				}

				return snapshot();
			});
		},

		async stopSession(): Promise<McpManagerState> {
			return runSerialized(async () => {
				lifecycle = "stopping";
				lifecycleReason = "stopping MCP manager";

				let stopError: string | undefined;
				try {
					await runtime.stop();
				} catch (error) {
					stopError = formatError(error);
				}

				toolLists.clear();
				markSessionStopped();
				lifecycle = "inactive";
				const runtimeStatus = runtime.getStatus();
				lifecycleReason = stopError
					? `stopped with error: ${stopError}`
					: (runtimeStatus.reason ?? "MCP manager stopped");
				return snapshot();
			});
		},

		async reloadSession(context: McpManagerSessionContext): Promise<McpManagerState> {
			return runSerialized(async () => {
				lifecycle = "starting";
				lifecycleReason = "reloading MCP manager";
				upsertSession(context, true);

				try {
					const resolved = resolveConfig(context);
					currentConfig = cloneResolvedConfig(resolved);
					await runtime.start(resolved);
					await refreshToolListsInternal();
					syncLifecycleFromRuntime();
				} catch (error) {
					await runtime.stop().catch(() => undefined);
					lifecycle = "error";
					lifecycleReason = `reload failed: ${formatError(error)}`;
					markSessionStopped();
					toolLists.clear();
				}

				return snapshot();
			});
		},

		async refreshToolLists(serverNames?: string[]): Promise<McpManagerState> {
			return runSerialized(async () => {
				await refreshToolListsInternal(serverNames);
				syncLifecycleFromRuntime();
				return snapshot();
			});
		},

		setSessionContext(context: McpManagerSessionContext): McpManagerState {
			upsertSession(context, false);
			return snapshot();
		},

		request(serverName: string, method: string, params: unknown = {}, options?: McpRequestOptions): Promise<unknown> {
			return runtime.request(serverName, method, params, options);
		},

		async listTools(serverName: string, options?: McpRequestOptions): Promise<unknown> {
			try {
				const response = await runtime.listTools(serverName, options);
				recordToolListSuccess(serverName, response);
				return response;
			} catch (error) {
				recordToolListError(serverName, formatError(error));
				throw error;
			}
		},

		callTool(serverName: string, toolName: string, args: unknown = {}, options?: McpRequestOptions): Promise<unknown> {
			return runtime.callTool(serverName, toolName, args, options);
		},

		getState(): McpManagerState {
			syncLifecycleFromRuntime();
			return snapshot();
		},
	};

	return manager;

	function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const run = lifecycleQueue.then(operation, operation);
		lifecycleQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function upsertSession(context: McpManagerSessionContext, isReload: boolean): void {
		const timestamp = now().toISOString();
		const isSameSession =
			!!sessionState &&
			sessionState.sessionId === context.sessionId &&
			sessionState.sessionFile === context.sessionFile &&
			sessionState.cwd === context.cwd;

		if (!sessionState || !isSameSession) {
			sessionState = {
				cwd: context.cwd,
				sessionId: context.sessionId,
				sessionFile: context.sessionFile,
				startedAt: timestamp,
				lastReloadAt: isReload ? timestamp : undefined,
				stoppedAt: undefined,
				reloadCount: isReload ? 1 : 0,
				isActive: true,
			};
			return;
		}

		sessionState = {
			...sessionState,
			cwd: context.cwd,
			sessionId: context.sessionId,
			sessionFile: context.sessionFile,
			isActive: true,
			stoppedAt: undefined,
			reloadCount: isReload ? sessionState.reloadCount + 1 : sessionState.reloadCount,
			lastReloadAt: isReload ? timestamp : sessionState.lastReloadAt,
		};
	}

	function markSessionStopped(): void {
		if (!sessionState) {
			return;
		}
		sessionState = {
			...sessionState,
			isActive: false,
			stoppedAt: now().toISOString(),
		};
	}

	async function refreshToolListsInternal(serverNames?: string[]): Promise<void> {
		const runtimeStatus = runtime.getStatus();
		const configuredServerNames = currentConfig.servers.map((server) => server.name);
		const targetServerNames = dedupeNames(serverNames ?? configuredServerNames);

		if (!serverNames) {
			const configured = new Set(configuredServerNames);
			for (const existing of toolLists.keys()) {
				if (!configured.has(existing)) {
					toolLists.delete(existing);
				}
			}
		}

		const statusesByServer = new Map(runtimeStatus.servers.map((server) => [server.name, server]));
		for (const serverName of targetServerNames) {
			const runtimeServerStatus = statusesByServer.get(serverName);
			if (!runtimeServerStatus || runtimeServerStatus.state !== "ready") {
				const reason = runtimeServerStatus
					? `server is ${runtimeServerStatus.state}: ${runtimeServerStatus.reason}`
					: "server is not running";
				recordToolListStale(serverName, reason);
				continue;
			}

			try {
				const response = await runtime.listTools(serverName, { timeoutMs: DEFAULT_TOOL_REFRESH_TIMEOUT_MS });
				recordToolListSuccess(serverName, response);
			} catch (error) {
				recordToolListError(serverName, formatError(error));
			}
		}
	}

	function recordToolListSuccess(serverName: string, response: unknown): void {
		const extractedTools = extractTools(response);
		toolLists.set(serverName, {
			server: serverName,
			state: "ready",
			reason: `refreshed ${extractedTools.length} tool(s)`,
			refreshedAt: now().toISOString(),
			tools: extractedTools,
		});
	}

	function recordToolListError(serverName: string, error: string): void {
		const existing = toolLists.get(serverName);
		toolLists.set(serverName, {
			server: serverName,
			state: "error",
			reason: error,
			refreshedAt: now().toISOString(),
			tools: existing?.tools ?? [],
		});
	}

	function recordToolListStale(serverName: string, reason: string): void {
		const existing = toolLists.get(serverName);
		toolLists.set(serverName, {
			server: serverName,
			state: "stale",
			reason,
			refreshedAt: existing?.refreshedAt,
			tools: existing?.tools ?? [],
		});
	}

	function syncLifecycleFromRuntime(): void {
		const runtimeStatus = runtime.getStatus();
		switch (runtimeStatus.state) {
			case "ready":
				lifecycle = "ready";
				lifecycleReason = runtimeStatus.reason;
				if (sessionState) {
					sessionState = {
						...sessionState,
						isActive: true,
						stoppedAt: undefined,
					};
				}
				return;
			case "error":
				lifecycle = "error";
				lifecycleReason = runtimeStatus.reason;
				return;
			case "inactive":
				if (lifecycle !== "inactive") {
					lifecycle = "inactive";
				}
				if (!lifecycleReason || lifecycleReason === "not started") {
					lifecycleReason = runtimeStatus.reason;
				}
				return;
			case "starting":
				lifecycle = "starting";
				lifecycleReason = runtimeStatus.reason;
		}
	}

	function snapshot(): McpManagerState {
		return {
			lifecycle,
			reason: lifecycleReason,
			session: sessionState ? { ...sessionState } : undefined,
			config: cloneResolvedConfig(currentConfig),
			runtime: cloneRuntimeStatus(runtime.getStatus()),
			toolLists: Object.fromEntries([...toolLists.entries()].map(([name, state]) => [name, { ...state }])),
		};
	}
}

function extractTools(response: unknown): unknown[] {
	if (!isObject(response) || !Array.isArray(response.tools)) {
		return [];
	}
	return [...response.tools];
}

function cloneResolvedConfig(config: McpResolvedConfig): McpResolvedConfig {
	return {
		servers: config.servers.map((server) => ({
			...server,
			args: [...server.args],
			headers: { ...server.headers },
			env: { ...server.env },
		})),
		diagnostics: config.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		sourcePaths: [...config.sourcePaths],
	};
}

function cloneRuntimeStatus(status: McpRuntimeStatus): McpRuntimeStatus {
	return {
		...status,
		servers: status.servers.map((server) => ({
			...server,
			command: server.command ? [...server.command] : undefined,
		})),
		diagnostics: [...status.diagnostics],
	};
}

function dedupeNames(names: string[]): string[] {
	const unique = new Set<string>();
	for (const name of names) {
		const normalized = name.trim();
		if (!normalized) {
			continue;
		}
		unique.add(normalized);
	}
	return [...unique];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
