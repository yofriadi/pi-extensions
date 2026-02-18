import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { McpResolvedConfig, McpServerConfig } from "../config/mcp-config.js";

const JSON_RPC_VERSION = "2.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_GRACE_MS = 250;
const MCP_SESSION_ID_HEADER = "mcp-session-id";
const HTTP_STOP_TIMEOUT_MS = 3_000;

type JsonRpcId = number | string;

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
	state: "starting" | "ready" | "error" | "inactive";
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
	private outputBuffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private status: McpRuntimeServerStatus;

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
		this.outputBuffer = Buffer.alloc(0);
		const processHandle = this.spawn(command, {
			env: mergedEnv,
		});
		this.process = processHandle;
		this.status = {
			...this.status,
			state: "starting",
			reason: "process started, waiting for initialize response",
			pid: processHandle.pid,
			command,
		};

		void this.consumeStream(processHandle.stdout, false);
		if (processHandle.stderr) {
			void this.consumeStream(processHandle.stderr, true);
		}
		void this.watchExit(processHandle.exited);

		try {
			await this.initializeHandshake();
			this.status = {
				...this.status,
				state: "ready",
				reason: "initialize handshake completed",
			};
		} catch (error) {
			await this.terminateProcess(processHandle, "initialize failed");
			this.status = {
				...this.status,
				state: "error",
				reason: `initialize failed: ${formatError(error)}`,
				pid: undefined,
			};
			throw error;
		}
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

		await this.terminateProcess(proc, "stopped");
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

		try {
			this.sendRequest(id, method, params);
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timeoutId);
				this.pending.delete(id);
			}
			throw error;
		}
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
		const framed = `Content-Length: ${Buffer.byteLength(serialized, "utf8")}\r\n\r\n${serialized}`;
		proc.stdin.write(framed);
	}

	private async consumeStream(stream: ReadableStream<Uint8Array>, isStdErr: boolean): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (!value || isStdErr) {
					continue;
				}
				this.outputBuffer =
					this.outputBuffer.length === 0 ? Buffer.from(value) : Buffer.concat([this.outputBuffer, Buffer.from(value)]);
				this.drainFrames();
			}
		} finally {
			reader.releaseLock();
		}
	}

	private drainFrames(): void {
		while (true) {
			const headerEnd = this.outputBuffer.indexOf("\r\n\r\n");
			if (headerEnd !== -1) {
				const header = this.outputBuffer.slice(0, headerEnd).toString("utf8");
				const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
				if (lengthMatch) {
					const contentLength = Number.parseInt(lengthMatch[1], 10);
					if (!Number.isFinite(contentLength) || contentLength < 0) {
						this.outputBuffer = this.outputBuffer.slice(headerEnd + 4);
						continue;
					}
					const frameEnd = headerEnd + 4 + contentLength;
					if (this.outputBuffer.length < frameEnd) {
						return;
					}

					const payload = this.outputBuffer.slice(headerEnd + 4, frameEnd).toString("utf8");
					this.outputBuffer = this.outputBuffer.slice(frameEnd);
					this.handleSerializedMessage(payload);
					continue;
				}
			}

			const newlineIndex = this.outputBuffer.indexOf(0x0a);
			if (newlineIndex === -1) {
				return;
			}

			const payload = this.outputBuffer.slice(0, newlineIndex).toString("utf8").trim();
			this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
			if (!payload || payload.startsWith("Content-Length:")) {
				continue;
			}
			this.handleSerializedMessage(payload);
		}
	}

	private handleSerializedMessage(payload: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		this.handleMessage(parsed);
	}

	private handleMessage(payload: unknown): void {
		if (!isObject(payload)) {
			return;
		}
		const response = payload as unknown as JsonRpcResponse;
		const responseId = normalizeJsonRpcId(response.id);
		if (responseId === undefined) {
			return;
		}

		const pending = this.pending.get(responseId);
		if (!pending) {
			return;
		}

		if (response.error) {
			pending.reject(new Error(`MCP ${this.server.name} error ${response.error.code}: ${response.error.message}`));
			return;
		}

		pending.resolve(response.result);
	}

	private async terminateProcess(proc: McpSubprocess, reason: string): Promise<void> {
		if (this.process === proc) {
			this.process = undefined;
		}

		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Server ${this.server.name} ${reason} before responding`));
		}
		this.pending.clear();

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

		const exited = await Promise.race([
			proc.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), PROCESS_EXIT_GRACE_MS)),
		]);
		if (exited === null && proc.kill) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Ignore kill errors.
			}
		}
		this.outputBuffer = Buffer.alloc(0);
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
	private sessionId: string | undefined;

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

		this.sessionId = undefined;
		this.status = {
			...this.status,
			state: "starting",
			reason: "http endpoint configured, waiting for initialize response",
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
			this.status = {
				...this.status,
				state: "ready",
				reason: "initialize handshake completed",
			};
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
		await this.terminateSession().catch(() => undefined);
		this.sessionId = undefined;
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
				headers: this.buildRequestHeaders(),
				body: JSON.stringify({
					jsonrpc: JSON_RPC_VERSION,
					id,
					method,
					params,
				}),
				signal: controller.signal,
			});

			const responseSessionId = readSessionIdFromHeaders(response.headers);
			if (responseSessionId) {
				this.sessionId = responseSessionId;
			}

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const authHints = [response.headers.get("www-authenticate"), response.headers.get("mcp-auth-server")]
					.filter(Boolean)
					.join("; ");
				const hintSuffix = authHints ? ` [${authHints}]` : "";
				throw new Error(
					`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}${hintSuffix}`,
				);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const json = contentType.includes("text/event-stream")
				? parseSseJsonRpcResponse(await response.text(), id)
				: ((await response.json()) as JsonRpcResponse);

			if (!json) {
				throw new Error("Failed to parse JSON response from MCP HTTP server");
			}

			if (json.error) {
				throw new Error(`MCP ${this.server.name} error ${json.error.code}: ${json.error.message}`);
			}
			return json.result;
		} finally {
			clearTimeout(timeout);
			cleanAbort();
		}
	}

	getStatus(): McpRuntimeServerStatus {
		return { ...this.status };
	}

	private buildRequestHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.server.headers,
		};
		if (this.sessionId) {
			headers[MCP_SESSION_ID_HEADER] = this.sessionId;
		}
		return headers;
	}

	private async terminateSession(): Promise<void> {
		if (!this.server.url || !this.sessionId) {
			return;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort(new Error(`MCP HTTP session stop timed out for ${this.server.name}`));
		}, HTTP_STOP_TIMEOUT_MS);

		try {
			await this.fetchImpl(this.server.url, {
				method: "DELETE",
				headers: {
					...this.server.headers,
					[MCP_SESSION_ID_HEADER]: this.sessionId,
				},
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
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
				try {
					await client.start();
					clients.set(server.name, client);
					status.servers.push(client.getStatus());
				} catch (error) {
					await client.stop().catch(() => undefined);
					status.servers.push({
						name: server.name,
						transport: server.transport,
						state: "error",
						reason: formatError(error),
						command: server.command ? [server.command, ...server.args] : undefined,
						url: server.url,
					});
				}
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
				kill: (signal?: string | number): unknown => processHandle.kill(normalizeKillSignal(signal)),
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
			stdout: toWebReadable(child.stdout),
			stderr: child.stderr ? toWebReadable(child.stderr) : null,
			exited: new Promise<number | null>((resolve) => {
				child.once("exit", (code) => resolve(code));
			}),
			kill: (signal?: string | number): unknown => child.kill(normalizeKillSignal(signal)),
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

function normalizeJsonRpcId(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number.parseInt(value, 10);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toWebReadable(stream: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

function normalizeKillSignal(signal?: string | number): NodeJS.Signals | number | undefined {
	if (typeof signal === "number") {
		return signal;
	}
	if (typeof signal === "string") {
		return signal as NodeJS.Signals;
	}
	return undefined;
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

function readSessionIdFromHeaders(headers: Headers): string | undefined {
	const raw = headers.get(MCP_SESSION_ID_HEADER);
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseSseJsonRpcResponse(payload: string, requestId: number): JsonRpcResponse | undefined {
	const lines = payload.split(/\r?\n/u);
	let dataLines: string[] = [];

	const tryParseEvent = (): JsonRpcResponse | undefined => {
		if (dataLines.length === 0) {
			return undefined;
		}
		const jsonPayload = dataLines.join("\n").trim();
		dataLines = [];
		if (!jsonPayload || jsonPayload === "[DONE]") {
			return undefined;
		}
		try {
			const parsed = JSON.parse(jsonPayload) as JsonRpcResponse;
			if (normalizeJsonRpcId(parsed?.id) === requestId) {
				return parsed;
			}
		} catch {
			// Ignore malformed SSE chunks and continue searching.
		}
		return undefined;
	};

	for (const rawLine of lines) {
		if (rawLine.length === 0) {
			const parsed = tryParseEvent();
			if (parsed) {
				return parsed;
			}
			continue;
		}

		if (rawLine.startsWith("data:")) {
			dataLines.push(rawLine.slice(5).trimStart());
		}
	}

	return tryParseEvent();
}

function cloneServerStatus(status: McpRuntimeServerStatus): McpRuntimeServerStatus {
	return {
		...status,
		command: status.command ? [...status.command] : undefined,
	};
}
