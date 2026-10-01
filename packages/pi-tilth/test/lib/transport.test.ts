import {
	type CallToolResult,
	isJsonRpcRequest,
	type JsonRpcId,
	type JsonRpcMessage,
	LATEST_PROTOCOL_VERSION,
} from "@earendil-works/pi-mcp";
import { InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { describe, expect, it } from "vitest";
import { createAvailabilityState } from "../../src/lib/availability";
import type { TilthConfig } from "../../src/lib/config";
import type { Exec } from "../../src/lib/exec";
import { callToolResultToText, ServerToolError, TransportError } from "../../src/lib/result";
import { TilthMcpTransport } from "../../src/lib/transport";

// ---------------------------------------------------------------------------
// result — MCP CallToolResult conversion
// ---------------------------------------------------------------------------

describe("callToolResultToText — MCP CallToolResult conversion", () => {
	it("joins text content blocks with newlines", () => {
		const result: CallToolResult = {
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		};
		expect(callToolResultToText(result)).toBe("one\ntwo");
	});

	it("maps isError results to ServerToolError with the server's own text", () => {
		const result: CallToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
		expect(() => callToolResultToText(result)).toThrowError(ServerToolError);
		try {
			callToolResultToText(result);
		} catch (err) {
			expect((err as ServerToolError).message).toBe("boom");
		}
	});

	it("reports an isError result with no text blocks explicitly", () => {
		const result: CallToolResult = { content: [], isError: true };
		expect(() => callToolResultToText(result)).toThrowError(/no text content/);
	});

	it("throws TransportError when a successful result has no text blocks", () => {
		expect(() => callToolResultToText({ content: [] })).toThrowError(TransportError);
	});
});

// ---------------------------------------------------------------------------
// availability — probe order
// ---------------------------------------------------------------------------

const fakeExec = (
	behavior: (cmd: string, args: string[]) => { stdout: string; stderr: string; code: number; killed: boolean },
): Exec => {
	return async (cmd, args) => behavior(cmd, args);
};

describe("availability — probe order", () => {
	it("resolves to binary when the tilth binary responds to --version", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd, args) => {
			if (cmd === "tilth" && args[0] === "--version")
				return { stdout: "tilth 0.10.1", stderr: "", code: 0, killed: false };
			throw new Error(`unexpected call: ${cmd}`);
		});
		await state.refresh(exec);
		expect(state.mode).toBe("binary");
	});

	it("falls back to npx when the binary is missing", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd, args) => {
			if (cmd === "tilth") return { stdout: "", stderr: "not installed", code: 127, killed: false };
			if (cmd === "npx" && args[0] === "--version") return { stdout: "10.x", stderr: "", code: 0, killed: false };
			throw new Error(`unexpected call: ${cmd}`);
		});
		await state.refresh(exec);
		expect(state.mode).toBe("npx");
	});

	it("becomes unavailable when nothing works", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec(() => ({ stdout: "", stderr: "nope", code: 1, killed: false }));
		await state.refresh(exec);
		expect(state.mode).toBe("unavailable");
	});

	it("treats probe crashes (e.g. timeout throws) as failures, not crashes", async () => {
		const state = createAvailabilityState();
		const exec: Exec = async () => {
			throw new Error("timed out");
		};
		await state.refresh(exec);
		expect(state.mode).toBe("unavailable");
	});

	it("treats a killed probe (code 0 via signal-death) as a failure", async () => {
		const state = createAvailabilityState();
		const exec = fakeExec((cmd) => ({
			stdout: cmd === "tilth" ? "tilth 0.10.1" : "10.x",
			stderr: "",
			code: 0,
			killed: true,
		}));
		await state.refresh(exec);
		expect(state.mode).toBe("unavailable");
	});

	it("starts undefined before the first refresh", () => {
		const state = createAvailabilityState();
		expect(state.mode).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// TilthMcpTransport — persistent connection lifecycle (in-memory transport)
// ---------------------------------------------------------------------------

type CallToolHandler = (name: string, args: Record<string, unknown> | undefined) => CallToolResult;

interface FakeServerHandle {
	/** Leave `initialize` unanswered (connect-timeout test). */
	hangInitialize: boolean;
	/** Delay the `initialize` reply (stop/connect race test). */
	initializeDelayMs: number;
	/** Leave `tools/call` unanswered (call-timeout test). */
	hangCall: boolean;
	/** Reply to `tools/call` with a JSON-RPC error instead of a result. */
	callError?: { code: number; message: string };
	onCallTool: CallToolHandler;
	callCount: number;
	closed: boolean;
	crash(): Promise<void>;
}

/** The client end of the in-memory pair, with the stderr buffer the wrapper reads. */
class TestClientTransport extends InMemoryTransport {
	stderr = "";
}

function attachFakeServer(server: InMemoryTransport): FakeServerHandle {
	const handle: FakeServerHandle = {
		hangInitialize: false,
		initializeDelayMs: 0,
		hangCall: false,
		onCallTool: () => ({ content: [{ type: "text", text: "ok" }] }),
		callCount: 0,
		closed: false,
		async crash() {
			await server.close();
		},
	};
	server.onClose(() => {
		handle.closed = true;
	});
	const reply = (id: JsonRpcId, result: unknown) => {
		void server.send({ jsonrpc: "2.0", id, result });
	};
	const replyError = (id: JsonRpcId, code: number, message: string) => {
		void server.send({ jsonrpc: "2.0", id, error: { code, message } });
	};
	server.onMessage((message: JsonRpcMessage) => {
		if (!isJsonRpcRequest(message)) return;
		const respond = async () => {
			if (message.method === "initialize") {
				if (handle.hangInitialize) return;
				if (handle.initializeDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, handle.initializeDelayMs));
				}
				reply(message.id, {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					serverInfo: { name: "fake-tilth", version: "0" },
				});
				return;
			}
			if (message.method === "tools/call") {
				handle.callCount += 1;
				if (handle.hangCall) return;
				if (handle.callError) {
					replyError(message.id, handle.callError.code, handle.callError.message);
					return;
				}
				const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
				reply(message.id, handle.onCallTool(params.name ?? "", params.arguments));
				return;
			}
			reply(message.id, {});
		};
		void respond();
	});
	return handle;
}

interface Harness {
	transport: TilthMcpTransport;
	servers: InMemoryTransport[];
	handles: FakeServerHandle[];
}

interface HarnessOptions {
	config?: Partial<TilthConfig>;
	/** Value the wrapper's bound transport reports for `.stderr`. */
	stderr?: string;
	onCallTool?: CallToolHandler;
	callError?: { code: number; message: string };
	hangInitialize?: boolean;
	initializeDelayMs?: number;
	hangCall?: boolean;
}

function makeHarness(options: HarnessOptions = {}): Harness {
	const servers: InMemoryTransport[] = [];
	const handles: FakeServerHandle[] = [];
	const transport = new TilthMcpTransport({
		mode: "binary",
		config: { callTimeoutMs: 2_000, hashlineCompat: false, ...options.config },
		cwd: "/tmp/fake-cwd",
		createTransport: () => {
			const client = new TestClientTransport();
			client.stderr = options.stderr ?? "";
			const server = new InMemoryTransport();
			client.connectPeer(server);
			server.connectPeer(client);
			// `start()` is async but flips `started` synchronously, so the
			// client's first send finds a started peer.
			void server.start();
			const handle = attachFakeServer(server);
			if (options.hangInitialize) handle.hangInitialize = true;
			if (options.initializeDelayMs !== undefined) handle.initializeDelayMs = options.initializeDelayMs;
			if (options.hangCall) handle.hangCall = true;
			if (options.callError) handle.callError = options.callError;
			if (options.onCallTool) handle.onCallTool = options.onCallTool;
			servers.push(server);
			handles.push(handle);
			return client;
		},
	});
	return { transport, servers, handles };
}

describe("TilthMcpTransport — persistent connection lifecycle", () => {
	it("connects lazily on the first call and reuses the process", async () => {
		const h = makeHarness();
		expect(h.servers).toHaveLength(0); // nothing spawned at construction
		expect(await h.transport.callTool("tilth_search", { query: "x" })).toBe("ok");
		expect(h.servers).toHaveLength(1);
		expect(h.handles[0]?.callCount).toBe(1);
		expect(h.transport.connected).toBe(true);

		expect(await h.transport.callTool("tilth_search", { query: "y" })).toBe("ok");
		expect(h.servers).toHaveLength(1); // same process, no respawn
		expect(h.handles[0]?.callCount).toBe(2);
		await h.transport.stop();
	});

	it("memoizes concurrent first calls to exactly one child process", async () => {
		const h = makeHarness();
		const results = await Promise.all([
			h.transport.callTool("tilth_search", { query: "a" }),
			h.transport.callTool("tilth_search", { query: "b" }),
			h.transport.callTool("tilth_search", { query: "c" }),
		]);
		expect(results).toEqual(["ok", "ok", "ok"]);
		expect(h.servers).toHaveLength(1);
		expect(h.handles[0]?.callCount).toBe(3);
		await h.transport.stop();
	});

	it("maps server isError results to ServerToolError (never retried)", async () => {
		const h = makeHarness({
			onCallTool: () => ({ content: [{ type: "text", text: "file not found: /x" }], isError: true }),
		});
		await expect(h.transport.callTool("tilth_read", { path: "/x" })).rejects.toThrowError(ServerToolError);
		expect(h.servers).toHaveLength(1);
		expect(h.handles[0]?.callCount).toBe(1);
		await h.transport.stop();
	});

	it("surfaces the attempt's captured stderr on a request-level failure", async () => {
		const h = makeHarness({
			callError: { code: -32603, message: "internal boom" },
			stderr: "panic: worker thread died",
		});
		try {
			await h.transport.callTool("tilth_search", { query: "x" });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(TransportError);
			expect((err as Error).message).toContain("internal boom");
			expect((err as Error).message).toContain("panic: worker thread died");
		}
		await h.transport.stop();
	});

	it("does not reconnect on a request-level failure (live connection)", async () => {
		const h = makeHarness({ callError: { code: -32603, message: "boom" } });
		await expect(h.transport.callTool("tilth_search", { query: "x" })).rejects.toThrow(/boom/);
		expect(h.servers).toHaveLength(1);
		expect(h.handles[0]?.callCount).toBe(1);
		await h.transport.stop();
	});

	it("surfaces a call timeout distinctly and keeps the connection open", async () => {
		const h = makeHarness({ hangCall: true, config: { callTimeoutMs: 60 } });
		await expect(h.transport.callTool("tilth_search", { query: "x" })).rejects.toThrow(
			/tilth tool call timed out after 60ms/,
		);
		expect(h.servers).toHaveLength(1); // timeout is not a transport failure
		expect(h.handles[0]?.callCount).toBe(1);
		await h.transport.stop();
	});

	it("reconnects once after the server process dies", async () => {
		const h = makeHarness();
		await h.transport.callTool("tilth_search", { query: "x" });
		expect(h.servers).toHaveLength(1);

		await h.handles[0]?.crash();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.transport.connected).toBe(false);

		expect(await h.transport.callTool("tilth_search", { query: "y" })).toBe("ok");
		expect(h.servers).toHaveLength(2); // fresh process spawned
		expect(h.handles[1]?.callCount).toBe(1);
		await h.transport.stop();
	});

	it("fails with a connection error when initialize times out", async () => {
		const h = makeHarness({ hangInitialize: true, config: { connectTimeoutMs: 50, callTimeoutMs: 1_000 } });
		await expect(h.transport.callTool("tilth_search", { query: "x" })).rejects.toThrow(/MCP connection failed/);
		expect(h.transport.connected).toBe(false);
		await h.transport.stop();
	});

	it("stop() is idempotent and post-shutdown calls never respawn", async () => {
		const h = makeHarness();
		await h.transport.callTool("tilth_search", { query: "x" });
		await h.transport.stop();
		await h.transport.stop(); // idempotent
		await expect(h.transport.callTool("tilth_search", { query: "y" })).rejects.toThrow(/shut down/);
		expect(h.servers).toHaveLength(1);
	});

	it("closes the freshly connected child when stop() races an in-flight connect", async () => {
		const h = makeHarness({ initializeDelayMs: 50 });
		const call = h.transport.callTool("tilth_search", { query: "x" });
		await new Promise((resolve) => setTimeout(resolve, 5)); // connect is now in flight
		await h.transport.stop();
		await expect(call).rejects.toThrow(/shut down/);
		expect(h.transport.connected).toBe(false);
		// The child was actually terminated, not leaked.
		expect(h.handles[0]?.closed).toBe(true);
	});
});
