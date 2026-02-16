import { spawn as spawnChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export type LspRuntimeState = "inactive" | "starting" | "ready" | "error";

export type LspTransportMode = "direct" | "lspmux-configured" | "lspmux-auto" | "direct-fallback";

export interface LspDiagnosticPosition {
	line: number;
	character: number;
}

export interface LspDiagnosticRange {
	start: LspDiagnosticPosition;
	end: LspDiagnosticPosition;
}

export interface LspDiagnostic {
	range: LspDiagnosticRange;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspRuntimeStatus {
	state: LspRuntimeState;
	reason: string;
	configuredCommand: string[] | undefined;
	activeCommand: string[] | undefined;
	transport: LspTransportMode | undefined;
	lspmuxAvailable: boolean;
	fallbackReason: string | undefined;
	pid: number | undefined;
	diagnosticsCount: number;
}

export interface LspSubprocess {
	pid: number | undefined;
	stdin: {
		write(data: string | Uint8Array): unknown;
		end(): unknown;
	};
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number | null>;
	kill(signal?: string | number): unknown;
}

export interface LspSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "pipe";
	stdout: "pipe";
	stderr: "pipe";
}

export type LspSpawn = (command: string[], options: LspSpawnOptions) => LspSubprocess;

interface PendingRpcRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

interface LaunchPlan {
	command: string[];
	transport: LspTransportMode;
}

interface PublishDiagnosticsParams {
	uri?: string;
	diagnostics?: unknown;
}

export interface LspClientRuntimeOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	lspmuxPath?: string;
	spawn?: LspSpawn;
}

export interface LspClientRuntime {
	start(configuredCommand: string[] | undefined): Promise<void>;
	stop(): Promise<void>;
	reload(configuredCommand: string[] | undefined): Promise<void>;
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	getPublishedDiagnostics(filePath?: string): LspDiagnostic[];
	getStatus(): LspRuntimeStatus;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_CONTENT_LENGTH = 4 * 1024 * 1024;
const LSPMUX_BINARY = "lspmux";

export function createLspClientRuntime(options: LspClientRuntimeOptions = {}): LspClientRuntime {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const spawnProcess: LspSpawn = options.spawn ?? createDefaultSpawn();

	let currentProcess: LspSubprocess | undefined;
	let isStopping = false;
	let nextRequestId = 1;
	let outputBuffer = Buffer.alloc(0);
	const pendingRequests = new Map<number, PendingRpcRequest>();
	const diagnosticsByUri = new Map<string, LspDiagnostic[]>();

	const status: LspRuntimeStatus = {
		state: "inactive",
		reason: "LSP runtime has not started yet.",
		configuredCommand: undefined,
		activeCommand: undefined,
		transport: undefined,
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: undefined,
		diagnosticsCount: 0,
	};

	return {
		async start(configuredCommand: string[] | undefined): Promise<void> {
			status.configuredCommand = cloneCommand(configuredCommand);
			status.fallbackReason = undefined;
			status.lspmuxAvailable = false;

			if (!configuredCommand || configuredCommand.length === 0) {
				setInactive("No LSP server command configured.");
				return;
			}

			if (currentProcess) {
				return;
			}

			const launchPlans = buildLaunchPlans(configuredCommand, options.lspmuxPath, env);
			status.lspmuxAvailable = launchPlans.some((plan) => plan.transport === "lspmux-auto");

			let previousError: Error | undefined;
			for (let index = 0; index < launchPlans.length; index++) {
				const plan = launchPlans[index];
				const isRetry = index > 0;
				try {
					await launch(plan);
					if (isRetry && previousError) {
						status.fallbackReason = previousError.message;
						status.transport = "direct-fallback";
					}
					return;
				} catch (error) {
					previousError = error instanceof Error ? error : new Error(String(error));
					await terminateProcess();
				}
			}

			status.state = "error";
			status.reason = previousError?.message ?? "Failed to start LSP runtime.";
			status.activeCommand = undefined;
			status.transport = undefined;
			status.pid = undefined;
		},

		async stop(): Promise<void> {
			if (!currentProcess) {
				setInactive("LSP runtime stopped.");
				return;
			}

			isStopping = true;
			try {
				await sendRequest("shutdown", null, 1_000).catch(() => undefined);
				sendNotification("exit", null);
			} finally {
				await terminateProcess();
				setInactive("LSP runtime stopped.");
				isStopping = false;
			}
		},

		async reload(configuredCommand: string[] | undefined): Promise<void> {
			await this.stop();
			await this.start(configuredCommand);
		},

		request(method: string, params: unknown, timeoutMs = requestTimeoutMs): Promise<unknown> {
			if (!currentProcess || status.state !== "ready") {
				throw new Error("LSP runtime is not ready.");
			}
			return sendRequest(method, params, timeoutMs);
		},

		getPublishedDiagnostics(filePath?: string): LspDiagnostic[] {
			if (filePath) {
				const uri = pathToFileURL(resolve(cwd, filePath)).href;
				return diagnosticsByUri.get(uri) ?? [];
			}

			const allDiagnostics: LspDiagnostic[] = [];
			for (const diagnostics of diagnosticsByUri.values()) {
				allDiagnostics.push(...diagnostics);
			}
			return allDiagnostics;
		},

		getStatus(): LspRuntimeStatus {
			return {
				...status,
				configuredCommand: cloneCommand(status.configuredCommand),
				activeCommand: cloneCommand(status.activeCommand),
			};
		},
	};

	function setInactive(reason: string): void {
		status.state = "inactive";
		status.reason = reason;
		status.activeCommand = undefined;
		status.transport = undefined;
		status.pid = undefined;
	}

	async function launch(plan: LaunchPlan): Promise<void> {
		status.state = "starting";
		status.reason = `Starting LSP server via ${plan.transport}.`;
		status.transport = plan.transport;
		status.activeCommand = cloneCommand(plan.command);
		status.pid = undefined;
		outputBuffer = Buffer.alloc(0);

		const processHandle = spawnProcess(plan.command, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		currentProcess = processHandle;
		status.pid = processHandle.pid;

		void readStream(processHandle.stdout, (chunk) => handleRpcOutput(chunk));
		void readStream(processHandle.stderr, () => undefined);

		processHandle.exited.then((code) => {
			if (processHandle !== currentProcess) {
				return;
			}
			if (isStopping) {
				return;
			}

			rejectPendingRequests(new Error("LSP process exited before requests completed."));
			currentProcess = undefined;
			status.state = "error";
			status.reason = `LSP process exited with code ${code}.`;
			status.pid = undefined;
		});

		await sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(cwd).href,
			capabilities: {},
			clientInfo: {
				name: "pi-lsp-scaffold",
				version: "0.1.0",
			},
		});
		sendNotification("initialized", {});

		status.state = "ready";
		status.reason = `LSP server ready via ${plan.transport}.`;
	}

	function sendNotification(method: string, params: unknown): void {
		sendMessage({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	function sendRequest(method: string, params: unknown, timeoutMs = requestTimeoutMs): Promise<unknown> {
		const requestId = nextRequestId++;
		return new Promise((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(requestId);
				rejectRequest(new Error(`Timed out waiting for JSON-RPC response to ${method}.`));
			}, timeoutMs);

			pendingRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timeout });
			sendMessage({
				jsonrpc: "2.0",
				id: requestId,
				method,
				params,
			});
		});
	}

	function sendMessage(message: unknown): void {
		if (!currentProcess) {
			throw new Error("LSP process is not running.");
		}
		const json = JSON.stringify(message);
		const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
		currentProcess.stdin.write(frame);
	}

	function handleRpcOutput(chunk: Uint8Array): void {
		if (outputBuffer.length + chunk.length > MAX_OUTPUT_BUFFER_BYTES) {
			rejectPendingRequests(new Error("LSP response buffer overflow."));
			void terminateProcess();
			status.state = "error";
			status.reason = `LSP response buffer exceeded ${MAX_OUTPUT_BUFFER_BYTES} bytes.`;
			outputBuffer = Buffer.alloc(0);
			return;
		}

		const nextChunk = Buffer.from(chunk);
		outputBuffer = outputBuffer.length === 0 ? nextChunk : Buffer.concat([outputBuffer, nextChunk]);

		while (true) {
			const headerEnd = outputBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}

			const header = outputBuffer.slice(0, headerEnd).toString("utf8");
			const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
			if (!lengthMatch) {
				outputBuffer = outputBuffer.slice(headerEnd + 4);
				continue;
			}

			const contentLength = Number.parseInt(lengthMatch[1], 10);
			if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_FRAME_CONTENT_LENGTH) {
				rejectPendingRequests(new Error(`Invalid LSP frame length: ${lengthMatch[1]}`));
				void terminateProcess();
				status.state = "error";
				status.reason = `Invalid LSP frame length ${lengthMatch[1]}.`;
				outputBuffer = Buffer.alloc(0);
				return;
			}

			const frameEnd = headerEnd + 4 + contentLength;
			if (outputBuffer.length < frameEnd) {
				return;
			}

			const payload = outputBuffer.slice(headerEnd + 4, frameEnd).toString("utf8");
			outputBuffer = outputBuffer.slice(frameEnd);
			handleRpcMessage(payload);
		}
	}

	function handleRpcMessage(payload: string): void {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(payload) as Record<string, unknown>;
		} catch {
			return;
		}

		if (typeof parsed.method === "string" && parsed.method === "textDocument/publishDiagnostics") {
			const params = (parsed.params ?? {}) as PublishDiagnosticsParams;
			if (typeof params.uri === "string") {
				const diagnostics = normalizeDiagnostics(params.diagnostics);
				diagnosticsByUri.set(params.uri, diagnostics);
				status.diagnosticsCount = countDiagnostics(diagnosticsByUri);
			}
			return;
		}

		const requestId = normalizeRequestId(parsed.id);
		if (requestId === undefined) {
			return;
		}

		const pending = pendingRequests.get(requestId);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timeout);
		pendingRequests.delete(requestId);

		if (parsed.error) {
			pending.reject(new Error(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error)));
			return;
		}

		pending.resolve(parsed.result);
	}

	async function terminateProcess(): Promise<void> {
		if (!currentProcess) {
			return;
		}

		const processHandle = currentProcess;
		currentProcess = undefined;
		rejectPendingRequests(new Error("LSP process stopped."));

		try {
			processHandle.stdin.end();
		} catch {
			// Ignore shutdown race.
		}

		const exited = await Promise.race([
			processHandle.exited,
			new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 1_000)),
		]);

		if (exited === null) {
			try {
				processHandle.kill("SIGKILL");
			} catch {
				// Ignore kill failures.
			}
		}
	}

	function rejectPendingRequests(error: Error): void {
		for (const pending of pendingRequests.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		pendingRequests.clear();
	}
}

function createDefaultSpawn(): LspSpawn {
	const bunRuntime = getBunRuntime();
	if (bunRuntime) {
		return (command, spawnOptions) =>
			bunRuntime.spawn(command, {
				cwd: spawnOptions.cwd,
				env: spawnOptions.env,
				stdin: spawnOptions.stdin,
				stdout: spawnOptions.stdout,
				stderr: spawnOptions.stderr,
			}) as unknown as LspSubprocess;
	}

	return (command, spawnOptions) => {
		if (command.length === 0 || !command[0]) {
			throw new Error("No LSP command provided.");
		}

		const [binary, ...args] = command;
		const child = spawnChildProcess(binary, args, {
			cwd: spawnOptions.cwd,
			env: spawnOptions.env,
			stdio: [spawnOptions.stdin, spawnOptions.stdout, spawnOptions.stderr],
		});

		if (!child.stdin || !child.stdout || !child.stderr) {
			throw new Error(`Failed to start LSP process ${binary}: stdio pipes unavailable.`);
		}

		return {
			pid: child.pid ?? undefined,
			stdin: child.stdin,
			stdout: toWebReadable(child.stdout),
			stderr: toWebReadable(child.stderr),
			exited: new Promise<number | null>((resolve, reject) => {
				child.once("error", (error) => reject(error));
				child.once("exit", (code) => resolve(code));
			}),
			kill(signal?: string | number): unknown {
				child.kill(signal as NodeJS.Signals | number | undefined);
				return undefined;
			},
		};
	};
}

function getBunRuntime():
	| {
			spawn(command: string[], options: LspSpawnOptions): unknown;
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
		spawn(command: string[], options: LspSpawnOptions): unknown;
	};
}

function buildLaunchPlans(
	configuredCommand: string[],
	explicitLspmuxPath: string | undefined,
	env: NodeJS.ProcessEnv,
): LaunchPlan[] {
	if (isLspmuxCommand(configuredCommand[0])) {
		return [{ command: configuredCommand, transport: "lspmux-configured" }];
	}

	const lspmuxPath = resolveLspmuxPath(explicitLspmuxPath, env);
	if (!lspmuxPath) {
		return [{ command: configuredCommand, transport: "direct" }];
	}

	return [
		{
			command: [lspmuxPath, "--", ...configuredCommand],
			transport: "lspmux-auto",
		},
		{
			command: configuredCommand,
			transport: "direct-fallback",
		},
	];
}

function resolveLspmuxPath(explicitPath: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (explicitPath) {
		return isExecutable(explicitPath) ? explicitPath : undefined;
	}

	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
	const pathValue = pathKey ? env[pathKey] : undefined;
	if (!pathValue) {
		return undefined;
	}

	for (const directory of pathValue.split(delimiter)) {
		if (!directory) {
			continue;
		}
		for (const candidateName of executableCandidates(LSPMUX_BINARY)) {
			const fullPath = join(directory, candidateName);
			if (isExecutable(fullPath)) {
				return fullPath;
			}
		}
	}

	const userFallback = join(homedir(), ".local", "bin", LSPMUX_BINARY);
	return isExecutable(userFallback) ? userFallback : undefined;
}

function executableCandidates(binary: string): string[] {
	if (process.platform !== "win32") {
		return [binary];
	}

	const lower = binary.toLowerCase();
	const candidates = [binary];
	if (!lower.endsWith(".exe")) candidates.push(`${binary}.exe`);
	if (!lower.endsWith(".cmd")) candidates.push(`${binary}.cmd`);
	if (!lower.endsWith(".bat")) candidates.push(`${binary}.bat`);
	return candidates;
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

function isLspmuxCommand(binary: string | undefined): boolean {
	if (!binary) {
		return false;
	}
	const name = basename(binary).toLowerCase();
	return name === "lspmux" || name === "lspmux.exe" || name === "lspmux.cmd" || name === "lspmux.bat";
}

function normalizeDiagnostics(rawDiagnostics: unknown): LspDiagnostic[] {
	if (!Array.isArray(rawDiagnostics)) {
		return [];
	}

	const diagnostics: LspDiagnostic[] = [];
	for (const raw of rawDiagnostics) {
		if (!raw || typeof raw !== "object") {
			continue;
		}

		const diagnostic = raw as Record<string, unknown>;
		const message = typeof diagnostic.message === "string" ? diagnostic.message : undefined;
		const range = normalizeRange(diagnostic.range);
		if (!message || !range) {
			continue;
		}

		diagnostics.push({
			range,
			severity: typeof diagnostic.severity === "number" ? diagnostic.severity : undefined,
			code: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? diagnostic.code : undefined,
			source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
			message,
		});
	}

	return diagnostics;
}

function normalizeRange(rawRange: unknown): LspDiagnosticRange | undefined {
	if (!rawRange || typeof rawRange !== "object") {
		return undefined;
	}
	const range = rawRange as Record<string, unknown>;
	const start = normalizePosition(range.start);
	const end = normalizePosition(range.end);
	if (!start || !end) {
		return undefined;
	}
	return { start, end };
}

function normalizePosition(rawPosition: unknown): LspDiagnosticPosition | undefined {
	if (!rawPosition || typeof rawPosition !== "object") {
		return undefined;
	}
	const position = rawPosition as Record<string, unknown>;
	if (typeof position.line !== "number" || typeof position.character !== "number") {
		return undefined;
	}
	return {
		line: position.line,
		character: position.character,
	};
}

function normalizeRequestId(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number.parseInt(value, 10);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function countDiagnostics(diagnosticsByUri: Map<string, LspDiagnostic[]>): number {
	let total = 0;
	for (const diagnostics of diagnosticsByUri.values()) {
		total += diagnostics.length;
	}
	return total;
}

function cloneCommand(command: string[] | undefined): string[] | undefined {
	return command ? [...command] : undefined;
}

function toWebReadable(stream: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

async function readStream(
	stream: ReadableStream<Uint8Array> | null,
	onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
	if (!stream) {
		return;
	}

	const reader = stream.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				onChunk(value);
			}
		}
	} finally {
		reader.releaseLock();
	}
}
