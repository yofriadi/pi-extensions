/**
 * Persistent in-process stdio MCP transport to `tilth --mcp`
 * (native-mcp-transport spec).
 *
 * One `TilthMcpTransport` instance wraps a single long-lived `McpClient` +
 * `StdioTransport` pair for the whole Pi session. The stdio child process is
 * spawned lazily on the first tool call (fast session start for sessions that
 * never use tilth) and kept open across turns, which is what activates
 * tilth's connection-scoped repeat-read dedup (`[shown earlier]`) and the
 * `/tilth-savings` counters.
 *
 * Lifecycle contract:
 *  - **Memoized connect**: the in-flight `connect()` promise is shared, so
 *    concurrent first calls spawn exactly one child process. The memo is
 *    cleared on rejection and on client close so later calls can retry.
 *  - **Signal racing**: a caller that aborts while connecting rejects
 *    immediately, but the in-flight connect continues in the background for
 *    subsequent calls.
 *  - **Auto-healing**: `client.onClose()` (identity-guarded against stale
 *    clients) discards the dead client; the next call lazily constructs a
 *    fresh `StdioTransport` + `McpClient`, retrying at most once per call.
 *    Note the fresh server process starts with empty read history and savings
 *    counters — an unexpected `/tilth-savings` reset means tilth restarted.
 *  - **Idempotent teardown**: `stop()` sets `disposed` so post-shutdown calls
 *    never respawn a process, and awaits `client.close()` (which SIGTERMs the
 *    child process group with `closeTimeoutMs: 2000`).
 */
import {
	McpAbortError,
	McpClient,
	McpTimeoutError,
	type McpTransport,
	StdioTransport,
	type StdioTransportOptions,
} from "@earendil-works/pi-mcp";
import packageJson from "../../package.json";
import type { TransportMode } from "./availability";
import type { TilthConfig } from "./config";
import { callToolResultToText, ServerToolError, TransportError } from "./result";

/** Spawn descriptor per resolved availability mode. */
function spawnDescriptor(mode: "binary" | "npx"): { command: string; args: string[] } {
	if (mode === "binary") return { command: "tilth", args: ["--mcp"] };
	return { command: "npx", args: ["-y", "tilth", "--mcp"] };
}

/** Connect/initialize budget: npx may download the package on a cold cache. */
function connectTimeoutMs(mode: "binary" | "npx", config: TilthConfig): number {
	return config.connectTimeoutMs ?? (mode === "npx" ? 120_000 : 30_000);
}

/**
 * The structural view of the stdio transport the wrapper needs: the full
 * `McpTransport` contract plus the accumulated stderr buffer. The real
 * `StdioTransport` satisfies it; tests inject an in-memory transport with a
 * settable `stderr`.
 */
export interface TilthStdioTransport extends McpTransport {
	readonly stderr: string;
}

export interface TilthMcpTransportOptions {
	/** Resolved availability mode (`binary` or `npx`; never `unavailable`). */
	mode: Exclude<TransportMode, "unavailable">;
	config: TilthConfig;
	/** Working directory the server process is spawned in (the session cwd). */
	cwd: string;
	/**
	 * Test seam: factory for the underlying stdio transport. Defaults to
	 * the real `StdioTransport`; tests inject a fake backed by the in-memory
	 * transport pair from `@earendil-works/pi-mcp/testing` (exposing a
	 * controllable `stderr` string and crash simulation).
	 */
	createTransport?: (options: StdioTransportOptions) => TilthStdioTransport;
}

/**
 * Session-scoped wrapper around one persistent `McpClient` connection to
 * `tilth --mcp`. `McpClient` is single-use: once closed it cannot reconnect,
 * so auto-healing means constructing a fresh client + transport pair.
 */
export class TilthMcpTransport {
	private readonly options: TilthMcpTransportOptions;
	/** Active client, or null before the first connect / after close. */
	private client: McpClient | null = null;
	/** Transport bound to `client` — retained because McpClient keeps its own private. */
	private transport: TilthStdioTransport | null = null;
	/** In-flight connect promise, shared by concurrent callers. */
	private connectPromise: Promise<void> | null = null;
	/** Set by `stop()`: post-shutdown calls must not respawn processes. */
	private disposed = false;

	constructor(options: TilthMcpTransportOptions) {
		this.options = options;
	}

	/** Whether a client is currently connected. */
	get connected(): boolean {
		return this.client !== null && this.client.connectionState === "connected";
	}

	/**
	 * Ensure a connected client, constructing one lazily. Memoized: parallel
	 * callers await the same promise (one child process). `signal` only races
	 * the wait — the connect itself continues for subsequent callers.
	 */
	private ensureConnected(signal?: AbortSignal): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new TransportError("tilth transport was shut down with the session"));
		}
		if (this.client !== null) return Promise.resolve();
		if (this.connectPromise === null) {
			const promise = this.spawnAndConnect();
			this.connectPromise = promise;
			// Clear the memo when it settles so the next call retries after a
			// rejection; after success the client itself short-circuits above,
			// and the close listener re-clears when the client dies.
			const clear = () => {
				if (this.connectPromise === promise) this.connectPromise = null;
			};
			promise.then(clear, clear);
		}
		const pending = this.connectPromise;
		if (signal === undefined) return pending;
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				cleanup();
				reject(new TransportError("tilth connect was aborted before completing"));
			};
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then(
				() => {
					cleanup();
					resolve();
				},
				(err) => {
					cleanup();
					reject(err);
				},
			);
		});
	}

	private async spawnAndConnect(): Promise<void> {
		const descriptor = spawnDescriptor(this.options.mode);
		const stdioOptions: StdioTransportOptions = {
			command: descriptor.command,
			args: descriptor.args,
			cwd: this.options.cwd,
			closeTimeoutMs: 2000,
		};
		const transport = this.options.createTransport?.(stdioOptions) ?? new StdioTransport(stdioOptions);
		const client = new McpClient({
			name: "pi-tilth",
			version: packageJson.version,
			requestTimeoutMs: connectTimeoutMs(this.options.mode, this.options.config),
		});
		// Identity-guarded close listener: a stale client's close event must
		// never nullify a newer client constructed in the meantime.
		client.onClose(() => {
			if (client !== this.client) return;
			this.client = null;
			this.transport = null;
			this.connectPromise = null;
		});
		// Late responses to cancelled/timed-out requests surface here as
		// "Received response for unknown MCP request N" — debug-level noise,
		// never a user-facing problem. Genuinely useful diagnostics (stdout
		// parse failures, send errors) also land here, so log rather than swallow.
		client.onError((error) => {
			console.debug("[pi-tilth mcp]", error.message);
		});
		try {
			await client.connect(transport);
		} catch (err) {
			const detail = transport.stderr.trim();
			const reason = err instanceof Error ? err.message : String(err);
			throw new TransportError(
				detail.length > 0
					? `tilth MCP connection failed: ${reason}\n${detail}`
					: `tilth MCP connection failed: ${reason}`,
			);
		}
		if (this.disposed) {
			// `stop()` raced this in-flight connect: close the freshly minted
			// client so the child process group is actually terminated — the
			// caller that survived the signal race must not resurrect a client
			// on a disposed transport.
			await client.close().catch(() => {});
			throw new TransportError("tilth transport was shut down while connecting");
		}
		this.client = client;
		this.transport = transport;
	}

	/**
	 * Call one tilth tool over the persistent connection and return the
	 * joined text of its content blocks.
	 *
	 * Server-reported errors (`isError: true`) throw `ServerToolError` with
	 * the server's text verbatim. Request-level failures (timeout, abort,
	 * JSON-RPC error) on a live connection throw `TransportError` without
	 * retrying. If the child process died, exactly one reconnect + retry is
	 * attempted, then the failure throws `TransportError` carrying the stderr
	 * captured from the transport bound to that attempt.
	 */
	async callTool(
		toolName: string,
		params: Record<string, unknown>,
		options: { signal?: AbortSignal } = {},
	): Promise<string> {
		// At most one reconnect per call.
		for (let attempt = 0; ; attempt++) {
			await this.ensureConnected(options.signal);
			const client = this.client;
			const transport = this.transport;
			if (client === null || transport === null) {
				// Connection raced closed between ensureConnected and here.
				if (attempt === 0) continue;
				throw new TransportError("tilth MCP connection is not established");
			}
			try {
				const result = await client.callTool(toolName, params, {
					...(options.signal !== undefined ? { signal: options.signal } : {}),
					timeoutMs: this.options.config.callTimeoutMs,
				});
				return callToolResultToText(result);
			} catch (err) {
				if (err instanceof ServerToolError) throw err;
				// Capture stderr from the transport bound to *this* attempt
				// before any reconnect discards it.
				const stderr = transport.stderr.trim();
				const reason = err instanceof Error ? err.message : String(err);
				// Request-level failures on a live connection are not transport
				// failures: name them for what they are (the connection stays
				// open — auto-heal only covers connection death).
				if (err instanceof McpTimeoutError) {
					throw new TransportError(
						`tilth tool call timed out after ${err.timeoutMs}ms — the request was cancelled; the persistent connection stays open`,
					);
				}
				if (err instanceof McpAbortError) {
					throw new TransportError(`tilth tool call was cancelled: ${reason}`);
				}
				const connectionDied = client !== this.client || client.connectionState !== "connected";
				if (connectionDied) {
					// Crash evidence (panics land on stderr) must not vanish when
					// the reconnect retry succeeds.
					if (stderr.length > 0)
						console.debug("[pi-tilth mcp] server connection lost, retrying. stderr:", stderr);
					if (attempt === 0) continue;
				}
				throw wrapTransportError(reason, stderr);
			}
		}
	}

	/** Idempotent teardown: close the client (SIGTERMs the child process group). */
	async stop(): Promise<void> {
		this.disposed = true;
		const client = this.client;
		this.client = null;
		this.transport = null;
		this.connectPromise = null;
		if (client !== null) {
			await client.close().catch(() => {});
		}
	}
}

function wrapTransportError(reason: string, stderr: string): TransportError {
	if (stderr.length > 0) {
		return new TransportError(`tilth MCP transport error: ${reason}\n${stderr}`);
	}
	return new TransportError(`tilth MCP transport error: ${reason}`);
}
