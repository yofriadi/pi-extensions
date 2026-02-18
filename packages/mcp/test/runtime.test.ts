import { describe, expect, it, vi } from "vitest";
import { createMcpRuntime } from "../src/runtime/mcp-runtime.js";

describe("mcp runtime", () => {
	it("does not report ready when stdio initialize handshake fails", async () => {
		const runtime = createMcpRuntime({
			spawn: () => ({
				pid: 123,
				stdin: {
					write: () => undefined,
					end: () => undefined,
				},
				stdout: new ReadableStream<Uint8Array>({
					start() {
						// never responds
					},
				}),
				stderr: null,
				exited: new Promise<number | null>(() => {}),
				kill: () => undefined,
			}),
		});

		await runtime.start({
			servers: [
				{
					name: "demo",
					transport: "stdio",
					command: "demo-server",
					args: [],
					headers: {},
					env: {},
					timeoutMs: 100,
					disabled: false,
					sourcePath: "test",
				},
			],
			diagnostics: [],
			sourcePaths: [],
		});

		const status = runtime.getStatus();
		expect(status.state).toBe("error");
		expect(status.activeServers).toBe(0);
		expect(status.servers[0]?.state).toBe("error");

		await expect(runtime.listTools("demo", { timeoutMs: 100 })).rejects.toThrow(/Unknown MCP server/);
	});

	it("clears pending shutdown timeout when stdio write throws during stop", async () => {
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;

		const runtime = createMcpRuntime({
			spawn: () => ({
				pid: 456,
				stdin: {
					write: (data: string | Uint8Array) => {
						const text = Buffer.from(data).toString("utf8");
						if (text.includes('"method":"shutdown"')) {
							throw new Error("EPIPE");
						}
						if (text.includes('"method":"initialize"') && stdoutController) {
							const payload = JSON.stringify({
								jsonrpc: "2.0",
								id: 1,
								result: {
									capabilities: {},
								},
							});
							stdoutController.enqueue(
								Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`),
							);
						}
						return undefined;
					},
					end: () => undefined,
				},
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						stdoutController = controller;
					},
				}),
				stderr: null,
				exited: new Promise<number | null>(() => {}),
				kill: () => undefined,
			}),
		});

		await runtime.start({
			servers: [
				{
					name: "demo",
					transport: "stdio",
					command: "demo-server",
					args: [],
					headers: {},
					env: {},
					timeoutMs: 100,
					disabled: false,
					sourcePath: "test",
				},
			],
			diagnostics: [],
			sourcePaths: [],
		});

		await runtime.stop();

		expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		clearTimeoutSpy.mockRestore();
	});
});
