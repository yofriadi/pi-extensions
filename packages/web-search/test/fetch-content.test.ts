import { describe, expect, it, vi } from "vitest";
import { registerFetchContentTool } from "../src/fetch/tool.js";

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
}

type RegisteredTools = Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

function setupTool(fetchImpl: typeof fetch): (params: Record<string, unknown>) => Promise<ToolResult> {
	const tools: RegisteredTools = {};
	registerFetchContentTool(
		{
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				tools[tool.name] = tool;
			},
		} as unknown as Parameters<typeof registerFetchContentTool>[0],
		{ fetchImpl },
	);

	const execute = tools.fetch_content?.execute;
	if (!execute) {
		throw new Error("fetch_content tool was not registered");
	}

	return async (params: Record<string, unknown>) =>
		execute("test", params, undefined, undefined, {
			cwd: process.cwd(),
			ui: {
				notify: vi.fn(),
			},
		}) as Promise<ToolResult>;
}

describe("fetch_content", () => {
	it("blocks private and loopback hosts", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const execute = setupTool(fetchImpl as unknown as typeof fetch);
		const result = await execute({
			url: "http://127.0.0.1:8080/admin",
		});

		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("Blocked URL host");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("aborts underlying fetches on timeout", async () => {
		let abortEvents = 0;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						abortEvents += 1;
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		});
		const execute = setupTool(fetchImpl as unknown as typeof fetch);
		const result = await execute({
			url: "https://example.com",
			timeoutMs: 200,
			prefer: "direct",
		});

		expect(result.isError).toBe(true);
		expect(abortEvents).toBeGreaterThan(0);
	});
});
