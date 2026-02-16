import { describe, expect, it } from "vitest";
import { createLspClientRuntime, type LspSpawn } from "../src/client/runtime.js";

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
};

describe("lsp runtime", () => {
	it("handles numeric-string JSON-RPC response ids", async () => {
		const spawn = createMockSpawn((message, emit) => {
			if (message.method === "initialize") {
				emit({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						capabilities: {},
					},
				});
				return;
			}

			if (message.method === "workspace/symbol") {
				emit({
					jsonrpc: "2.0",
					id: String(message.id),
					result: [{ name: "exampleSymbol" }],
				});
				return;
			}

			if (message.method === "shutdown") {
				emit({
					jsonrpc: "2.0",
					id: message.id,
					result: null,
				});
			}
		});

		const runtime = createLspClientRuntime({
			spawn,
			requestTimeoutMs: 200,
		});

		await runtime.start(["dummy-lsp"]);
		const result = await runtime.request("workspace/symbol", { query: "example" }, 200);
		expect(result).toEqual([{ name: "exampleSymbol" }]);
		expect(runtime.getStatus().state).toBe("ready");

		await runtime.stop();
	});

	it("reports error when initialize handshake times out", async () => {
		const spawn = createMockSpawn(() => {
			// Intentionally never respond.
		});

		const runtime = createLspClientRuntime({
			spawn,
			requestTimeoutMs: 100,
		});

		await runtime.start(["dummy-lsp"]);
		const status = runtime.getStatus();
		expect(status.state).toBe("error");
		expect(status.reason).toContain("Timed out waiting for JSON-RPC response to initialize");

		expect(() => runtime.request("workspace/symbol", { query: "x" })).toThrow(/not ready/i);
		await runtime.stop();
	});
});

function createMockSpawn(
	onRequest: (message: JsonRpcMessage, emit: (payload: JsonRpcMessage) => void) => void,
): LspSpawn {
	return () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let resolveExited: ((code: number | null) => void) | undefined;
		const exited = new Promise<number | null>((resolve) => {
			resolveExited = resolve;
		});

		const stdout = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});

		const emit = (payload: JsonRpcMessage) => {
			if (!controller) {
				return;
			}
			const json = JSON.stringify(payload);
			const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
			controller.enqueue(new TextEncoder().encode(frame));
		};

		return {
			pid: 4242,
			stdin: {
				write(data) {
					const message = parseOutgoingMessage(data);
					if (message) {
						onRequest(message, emit);
					}
					return undefined;
				},
				end() {
					resolveExited?.(0);
					return undefined;
				},
			},
			stdout,
			stderr: null,
			exited,
			kill() {
				resolveExited?.(0);
				controller?.close();
				return undefined;
			},
		};
	};
}

function parseOutgoingMessage(data: string | Uint8Array): JsonRpcMessage | undefined {
	const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
	const separatorIndex = raw.indexOf("\r\n\r\n");
	if (separatorIndex === -1) {
		return undefined;
	}

	const payload = raw.slice(separatorIndex + 4);
	if (!payload.trim()) {
		return undefined;
	}

	try {
		return JSON.parse(payload) as JsonRpcMessage;
	} catch {
		return undefined;
	}
}
