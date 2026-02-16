import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { McpResolvedConfig, McpServerConfig } from "../config/mcp-config.js";

const JSON_RPC_VERSION = "2.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type JsonRpcId = number;

interface JsonRpcResponse {
	jsonrpc: string;
	id: JsonRpcId;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface McpSpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

interface McpSubprocess {
	pid: number | undefined;
	stdin: {
		write(data: string | Uint8Array): unknown;
		end(): unknown;
	};
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number | null>;
	kill?(signal?: string | number): unknown;
}

export type McpSpawn = (command: string[], options: McpSpawnOptions) => McpSubprocess;

export interface McpRuntimeServerStatus {
	name: string;
	transport: "stdio" | "http";
	state: "ready" | "error" | "inactive";
	reason: string;
	pid?: number;
	command?: string[];
	url?: string;
}

export interface McpRuntimeStatus {
	state: "inactive" | "starting" | "ready" | "error";
	reason: string;
	configuredServers: number;
	activeServers: number;
	servers: McpRuntimeServerStatus[];
	diagnostics: string[];
}

export interface McpRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface McpRuntime {
	start(config: McpResolvedConfig): Promise<void>;
	stop(): Promise<void>;
	request(serverName: string, method: string, params?: unknown, options?: McpRequestOptions): Promise<unknown>;
	listTools(serverName: string, options?: McpRequestOptions): Promise<unknown>;
	callTool(serverName: string, toolName: string, args?: unknown, options?: McpRequestOptions): Promise<unknown>;
	getStatus(): McpRuntimeStatus;
}

interface McpRuntimeOptions {
	spawn?: McpSpawn;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

interface McpClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	request(method: string, params: unknown, options?: McpRequestOptions): Promise<unknown>;
	getStatus(): McpRuntimeServerStatus;
}

class McpStdioClient implements McpClient {
	private process: McpSubprocess | undefined;
	private lineBuffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private status: McpRuntimeServerStatus;
	private readonly textDecoder = new TextDecoder();

	constructor(
		private readonly server: McpServerConfig,
		private readonly spawn: McpSpawn,
		private readonly env: NodeJS.ProcessEnv,
	) {
		this.status = {
			name: server.name,
			transport: "stdio",
			state: "inactive",
			reason: "not started",
			command: server.command ? [server.command, ...server.args] : undefined,
		};
	}

	async start(): Promise<void> {
		if (!this.server.command) {
			throw new Error(`Server ${this.server.name} is missing command`);
		}

		const mergedEnv: NodeJS.ProcessEnv = {
			...this.env,
			...this.server.env,
		};

		const command = [this.server.command, ...this.server.args];
		this.process = this.spawn(command, {
			env: mergedEnv,
		});
		this.status = {
			...this.status,
			state: "ready",
			reason: "process started",
			pid: this.process.pid,
			command,
		};

		void this.consumeStream(this.process.stdout, false);
		if (this.process.stderr) {
			void this.consumeStream(this.process.stderr, true);
		}
		void this.watchExit(this.process.exited);

		await this.initializeHandshake();
	}

	async stop(): Promise<void> {
		const proc = this.process;
		if (!proc) {
			this.status = {
				...this.status,
				state: "inactive",
				reason: "already stopped",
			};
			return;
		}

		this.process = undefined;

		try {
			await this.request("shutdown", null, {
				timeoutMs: 3_000,
			});
		} catch {
			// Best effort shutdown.
		}

		try {
			this.sendNotification("exit", null);
		} catch {
			// Ignore notify failures while shutting down.
		}

		try {
			proc.stdin.end();
		} catch {
			// Ignore end errors.
		}

		if (proc.kill) {
			try {
				proc.kill("SIGTERM");
			} catch {
				// Ignore kill errors.
			}
		}

		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Server ${this.server.name} stopped before responding`));
		}
		this.pending.clear();

		this.status = {
			...this.status,
			state: "inactive",
			reason: "stopped",
			pid: undefined,
		};
	}

	async request(method: string, params: unknown, options: McpRequestOptions = {}): Promise<unknown> {
		const proc = this.process;
		if (!proc) {
			throw new Error(`Server ${this.server.name} is not running`);
		}

		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.server.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

		const timeoutPromise = new Promise<never>((_, reject) => {
			const timeoutId = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request timed out for ${this.server.name}: ${method}`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: () => {},
				reject: (error) => reject(error),
				timeoutId,
			});
		});

		const responsePromise = new Promise<unknown>((resolve, reject) => {
			const pending = this.pending.get(id);
			if (!pending) {
				reject(new Error(`Internal MCP runtime error: pending request ${id} missing`));
				return;
			}
			pending.resolve = (value) => {
				clearTimeout(pending.timeoutId);
				this.pending.delete(id);
				resolve(value);
			};
			pending.reject = (error) => {
				clearTimeout(pending.timeoutId);
				this.pending.delete(id);
				reject(error);
			};
		});

		this.sendRequest(id, method, params);
		const requestPromise = Promise.race([responsePromise, timeoutPromise]);
		if (options.signal) {
			return withAbort(requestPromise, options.signal, `MCP request aborted: ${method}`);
		}
		return requestPromise;
	}

	getStatus(): McpRuntimeServerStatus {
		return { ...this.status };
	}

	private async initializeHandshake(): Promise<void> {
		await this.request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: {
					name: "pi-extension-mcp-scaffold",
					version: "0.1.0",
				},
			},
			{ timeoutMs: this.server.timeoutMs },
		);
		this.sendNotification("notifications/initialized", {});
	}

	private sendRequest(id: number, method: string, params: unknown): void {
		this.writeJsonRpc({
			jsonrpc: JSON_RPC_VERSION,
			id,
			method,
			params,
		});
	}

	private sendNotification(method: string, params: unknown): void {
		this.writeJsonRpc({
			jsonrpc: JSON_RPC_VERSION,
			method,
			params,
		});
	}

	private writeJsonRpc(payload: Record<string, unknown>): void {
		const proc = this.process;
		if (!proc) {
			throw new Error(`Server ${this.server.name} is not running`);
		}

		const serialized = JSON.stringify(payload);
		proc.stdin.write(`${serialized}\n`);
	}

	private async consumeStream(stream: ReadableStream<Uint8Array>, isStdErr: boolean): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (!value) {
					continue;
				}
				if (isStdErr) {
					continue;
				}
				this.lineBuffer += this.textDecoder.decode(value, { stream: true });
				this.drainLines();
			}
		} finally {
			reader.releaseLock();
		}
	}

	private drainLines(): void {
		while (true) {
			const newlineIndex = this.lineBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const payload = this.lineBuffer.slice(0, newlineIndex).trim();
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			if (!payload) {
				continue;
			}
			if (payload.startsWith("Content-Length:")) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}
			this.handleMessage(parsed);
		}
	}

	private handleMessage(payload: unknown): void {
		if (!isObject(payload) || typeof payload.id !== "number") {
			return;
		}
		const response = payload as unknown as JsonRpcResponse;
		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}

		if (response.error) {
			pending.reject(new Error(`MCP ${this.server.name} error ${response.error.code}: ${response.error.message}`));
			return;
		}

		pending.resolve(response.result);
	}

	private async watchExit(exited: Promise<number | null>): Promise<void> {
		const exitCode = await exited;
		if (this.process) {
			this.process = undefined;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`MCP server ${this.server.name} exited with code ${exitCode ?? "unknown"}`));
		}
		this.pending.clear();
		if (this.status.state === "inactive") {
			return;
		}
		this.status = {
			...this.status,
			state: "error",
			reason: `process exited with code ${exitCode ?? "unknown"}`,
			pid: undefined,
		};
	}
}

class McpHttpClient implements McpClient {
	private status: McpRuntimeServerStatus;
	private nextId = 1;

	constructor(
		private readonly server: McpServerConfig,
		private readonly fetchImpl: typeof fetch,
	) {
		this.status = {
			name: server.name,
			transport: "http",
			state: "inactive",
			reason: "not started",
			url: server.url,
		};
	}

	async start(): Promise<void> {
		if (!this.server.url) {
			throw new Error(`Server ${this.server.name} is missing URL`);
		}

		this.status = {
			...this.status,
			state: "ready",
			reason: "http endpoint configured",
		};

		try {
			await this.request(
				"initialize",
				{
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: {
						name: "pi-extension-mcp-scaffold",
						version: "0.1.0",
					},
				},
				{ timeoutMs: this.server.timeoutMs },
			);
		} catch (error) {
			this.status = {
				...this.status,
				state: "error",
				reason: `initialize failed: ${formatError(error)}`,
			};
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.status = {
			...this.status,
			state: "inactive",
			reason: "stopped",
		};
	}

	async request(method: string, params: unknown, options: McpRequestOptions = {}): Promise<unknown> {
		if (!this.server.url) {
			throw new Error(`Server ${this.server.name} is missing URL`);
		}

		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.server.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort(new Error(`MCP HTTP request timed out for ${this.server.name}: ${method}`));
		}, timeoutMs);

		const cleanAbort = bindAbortSignal(options.signal, controller);

		try {
			const response = await this.fetchImpl(this.server.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...this.server.headers,
				},
				body: JSON.stringify({
					jsonrpc: JSON_RPC_VERSION,
					id,
					method,
					params,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const json = contentType.includes("text/event-stream")
				? parseSseJsonRpcResponse(await response.text(), id)
				: ((await response.json()) as JsonRpcResponse);

			if (!json) {
				throw new Error("Failed to parse JSON response from MCP HTTP server");
			}

			if (json?.error) {
				throw new Error(`MCP ${this.server.name} error ${json.error.code}: ${json.error.message}`);
			}
			return json?.result;
		} finally {
			clearTimeout(timeout);
			cleanAbort();
		}
	}

	getStatus(): McpRuntimeServerStatus {
		return { ...this.status };
	}
}

export function createMcpRuntime(options: McpRuntimeOptions = {}): McpRuntime {
	const spawn = options.spawn ?? createDefaultSpawn();
	const fetchImpl = options.fetchImpl ?? fetch;
	const env = options.env ?? process.env;
	const clients = new Map<string, McpClient>();
	let status: McpRuntimeStatus = {
		state: "inactive",
		reason: "not started",
		configuredServers: 0,
		activeServers: 0,
		servers: [],
		diagnostics: [],
	};

	function buildStatusSnapshot(): McpRuntimeStatus {
		const serverStatuses = status.servers.map((server) => {
			const liveStatus = clients.get(server.name)?.getStatus();
			return liveStatus ?? cloneServerStatus(server);
		});
		const activeServers = serverStatuses.filter((entry) => entry.state === "ready").length;

		let state = status.state;
		let reason = status.reason;
		if (state !== "inactive" && state !== "starting") {
			if (activeServers > 0) {
				state = "ready";
				reason = `connected to ${activeServers} MCP server(s)`;
			} else if (status.configuredServers === 0) {
				state = "inactive";
				reason = "no MCP servers configured";
			} else {
				state = "error";
				const firstError = serverStatuses.find((entry) => entry.state === "error");
				reason = firstError?.reason ?? "all MCP servers failed to start";
			}
		}

		return {
			...status,
			state,
			reason,
			activeServers,
			servers: serverStatuses.map(cloneServerStatus),
			diagnostics: [...status.diagnostics],
		};
	}

	return {
		async start(config: McpResolvedConfig): Promise<void> {
			await this.stop();

			status = {
				...status,
				state: "starting",
				reason: "starting servers",
				configuredServers: config.servers.length,
				activeServers: 0,
				servers: [],
				diagnostics: config.diagnostics.map((diag) => `${diag.level}:${diag.code}:${diag.message}`),
			};

			for (const server of config.servers) {
				if (server.disabled) {
					continue;
				}

				const client: McpClient =
					server.transport === "http" ? new McpHttpClient(server, fetchImpl) : new McpStdioClient(server, spawn, env);
				clients.set(server.name, client);
				try {
					await client.start();
				} catch (error) {
					status.servers.push({
						name: server.name,
						transport: server.transport,
						state: "error",
						reason: formatError(error),
						command: server.command ? [server.command, ...server.args] : undefined,
						url: server.url,
					});
					continue;
				}
				status.servers.push(client.getStatus());
			}

			status.activeServers = status.servers.filter((entry) => entry.state === "ready").length;
			if (status.activeServers > 0) {
				status.state = "ready";
				status.reason = `connected to ${status.activeServers} MCP server(s)`;
			} else if (status.configuredServers === 0) {
				status.state = "inactive";
				status.reason = "no MCP servers configured";
			} else {
				status.state = "error";
				status.reason = "all MCP servers failed to start";
			}
		},

		async stop(): Promise<void> {
			const stopResults = await Promise.allSettled([...clients.values()].map((client) => client.stop()));
			clients.clear();
			const stopErrors = stopResults.filter((result) => result.status === "rejected");
			status = {
				...status,
				state: "inactive",
				reason: stopErrors.length > 0 ? `stopped with ${stopErrors.length} error(s)` : "stopped",
				activeServers: 0,
				servers: [],
			};
		},

		async request(
			serverName: string,
			method: string,
			params: unknown = {},
			options: McpRequestOptions = {},
		): Promise<unknown> {
			const client = clients.get(serverName);
			if (!client) {
				throw new Error(`Unknown MCP server: ${serverName}`);
			}
			return client.request(method, params, options);
		},

		async listTools(serverName: string, options?: McpRequestOptions): Promise<unknown> {
			return this.request(serverName, "tools/list", {}, options);
		},

		async callTool(
			serverName: string,
			toolName: string,
			args: unknown = {},
			options?: McpRequestOptions,
		): Promise<unknown> {
			return this.request(
				serverName,
				"tools/call",
				{
					name: toolName,
					arguments: args,
				},
				options,
			);
		},

		getStatus(): McpRuntimeStatus {
			return buildStatusSnapshot();
		},
	};
}

function createDefaultSpawn(): McpSpawn {
	const bun = getBunRuntime();
	if (bun) {
		return (command: string[], options: McpSpawnOptions): McpSubprocess => {
			const processHandle = bun.spawn({
				cmd: command,
				cwd: options.cwd,
				env: options.env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			return {
				pid: processHandle.pid,
				stdin: processHandle.stdin,
				stdout: processHandle.stdout,
				stderr: processHandle.stderr,
				exited: processHandle.exited,
				kill: (signal?: string | number): unknown => processHandle.kill(signal as any),
			};
		};
	}

	return (command: string[], options: McpSpawnOptions): McpSubprocess => {
		const child = nodeSpawn(command[0], command.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (!child.stdin || !child.stdout) {
			throw new Error(`Failed to spawn MCP server process for command: ${command.join(" ")}`);
		}

		return {
			pid: child.pid ?? undefined,
			stdin: child.stdin,
			stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
			stderr: child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>) : null,
			exited: new Promise<number | null>((resolve) => {
				child.once("exit", (code) => resolve(code));
			}),
			kill: (signal?: string | number): unknown => child.kill(signal as any),
		};
	};
}

function getBunRuntime():
	| {
			spawn(options: {
				cmd: string[];
				cwd?: string;
				env?: NodeJS.ProcessEnv;
				stdin: "pipe";
				stdout: "pipe";
				stderr: "pipe";
			}): {
				pid: number | undefined;
				stdin: {
					write(data: string | Uint8Array): unknown;
					end(): unknown;
				};
				stdout: ReadableStream<Uint8Array>;
				stderr: ReadableStream<Uint8Array>;
				exited: Promise<number | null>;
				kill(signal?: string | number): unknown;
			};
	  }
	| undefined {
	const candidate = (globalThis as { Bun?: unknown }).Bun;
	if (!candidate || typeof candidate !== "object") {
		return undefined;
	}
	const bunLike = candidate as {
		spawn?: unknown;
	};
	if (typeof bunLike.spawn !== "function") {
		return undefined;
	}
	return bunLike as {
		spawn(options: {
			cmd: string[];
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			stdin: "pipe";
			stdout: "pipe";
			stderr: "pipe";
		}): {
			pid: number | undefined;
			stdin: {
				write(data: string | Uint8Array): unknown;
				end(): unknown;
			};
			stdout: ReadableStream<Uint8Array>;
			stderr: ReadableStream<Uint8Array>;
			exited: Promise<number | null>;
			kill(signal?: string | number): unknown;
		};
	};
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

function bindAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
	if (!signal) {
		return () => {};
	}
	const onAbort = () => {
		controller.abort(signal.reason ?? new Error("MCP request aborted"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new Error(message));
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error(message));
		signal.addEventListener("abort", onAbort, { once: true });
		promise
			.then(resolve)
			.catch(reject)
			.finally(() => {
				signal.removeEventListener("abort", onAbort);
			});
	});
}

function parseSseJsonRpcResponse(payload: string, requestId: number): JsonRpcResponse | undefined {
	const lines = payload.split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) {
			continue;
		}
		const jsonPayload = line.slice(5).trim();
		if (!jsonPayload || jsonPayload === "[DONE]") {
			continue;
		}
		try {
			const parsed = JSON.parse(jsonPayload) as JsonRpcResponse;
			if (parsed?.id === requestId) {
				return parsed;
			}
		} catch {
			// Ignore malformed SSE chunks and continue searching.
		}
	}
	return undefined;
}

function cloneServerStatus(status: McpRuntimeServerStatus): McpRuntimeServerStatus {
	return {
		...status,
		command: status.command ? [...status.command] : undefined,
	};
}
