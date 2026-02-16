import { describe, expect, it } from "vitest";
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
});
