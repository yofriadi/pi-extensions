import { describe, expect, it, vi } from "vitest";
import { createMcpRuntime } from "../src/runtime/mcp-runtime.js";

describe("mcp runtime http transport", () => {
	it("propagates MCP session id across requests and sends DELETE on stop", async () => {
		const calls: Array<{ method: string; headers: Headers; body?: Record<string, unknown> }> = [];
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const method = (init?.method ?? "GET").toUpperCase();
			const headers = new Headers(init?.headers);
			const body = parseBody(init?.body);
			calls.push({ method, headers, body });

			if (method === "POST" && body?.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { capabilities: {} },
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
							"mcp-session-id": "session-123",
						},
					},
				);
			}

			if (method === "POST" && body?.method === "tools/list") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [{ name: "tool-a" }] },
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			}

			if (method === "DELETE") {
				return new Response("", { status: 204 });
			}

			return new Response("unexpected", { status: 500, statusText: "Unexpected" });
		});

		const runtime = createMcpRuntime({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		await runtime.start({
			servers: [
				{
					name: "http-server",
					transport: "http",
					url: "https://example.test/mcp",
					command: undefined,
					args: [],
					headers: {},
					env: {},
					timeoutMs: 500,
					disabled: false,
					sourcePath: "test",
				},
			],
			diagnostics: [],
			sourcePaths: [],
		});

		const tools = await runtime.listTools("http-server", { timeoutMs: 500 });
		expect(tools).toEqual({ tools: [{ name: "tool-a" }] });

		await runtime.stop();

		const initializeCall = calls.find((call) => call.method === "POST" && call.body?.method === "initialize");
		const listToolsCall = calls.find((call) => call.method === "POST" && call.body?.method === "tools/list");
		const deleteCall = calls.find((call) => call.method === "DELETE");

		expect(initializeCall?.headers.get("mcp-session-id")).toBeNull();
		expect(listToolsCall?.headers.get("mcp-session-id")).toBe("session-123");
		expect(deleteCall?.headers.get("mcp-session-id")).toBe("session-123");
	});

	it("parses event-stream responses with multiline SSE payload", async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const method = (init?.method ?? "GET").toUpperCase();
			const body = parseBody(init?.body);

			if (method === "POST" && body?.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { capabilities: {} },
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			}

			if (method === "POST" && body?.method === "tools/list") {
				const targetId = String(body.id ?? "2");
				const streamPayload = [
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: "999", result: { tools: [{ name: "ignore" }] } })}`,
					"",
					"event: message",
					'data: {"jsonrpc":"2.0",',
					`data: "id":"${targetId}",`,
					'data: "result":{"tools":[{"name":"sse-tool"}]}}',
					"",
				].join("\n");

				return new Response(streamPayload, {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
					},
				});
			}

			return new Response("unexpected", { status: 500, statusText: "Unexpected" });
		});

		const runtime = createMcpRuntime({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		await runtime.start({
			servers: [
				{
					name: "sse-server",
					transport: "http",
					url: "https://example.test/mcp-sse",
					command: undefined,
					args: [],
					headers: {},
					env: {},
					timeoutMs: 500,
					disabled: false,
					sourcePath: "test",
				},
			],
			diagnostics: [],
			sourcePaths: [],
		});

		const tools = await runtime.listTools("sse-server", { timeoutMs: 500 });
		expect(tools).toEqual({ tools: [{ name: "sse-tool" }] });

		await runtime.stop();
	});
});

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
	if (typeof body !== "string") {
		return undefined;
	}

	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		return parsed;
	} catch {
		return undefined;
	}
}
