import { describe, expect, it, vi } from "vitest";
import type { ResolvedWebAccessProviderKeys } from "../src/config.js";
import { registerWebSearchTool } from "../src/search/tool.js";

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
	details?: Record<string, unknown>;
}

type RegisteredTools = Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

function createKeys(exaApiKey?: string, perplexityApiKey?: string): ResolvedWebAccessProviderKeys {
	return {
		exaApiKey,
		perplexityApiKey,
		sources: {
			exaApiKey: exaApiKey ? "env" : "none",
			perplexityApiKey: perplexityApiKey ? "env" : "none",
		},
		warnings: [],
	};
}

function setupTool(options: {
	fetchImpl: typeof fetch;
	keys: ResolvedWebAccessProviderKeys;
}): (params: Record<string, unknown>) => Promise<ToolResult> {
	const tools: RegisteredTools = {};
	registerWebSearchTool(
		{
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				tools[tool.name] = tool;
			},
		} as unknown as Parameters<typeof registerWebSearchTool>[0],
		{
			fetchImpl: options.fetchImpl,
			resolveKeys: () => options.keys,
		},
	);

	const execute = tools.web_search?.execute;
	if (!execute) {
		throw new Error("web_search tool was not registered");
	}

	return async (params: Record<string, unknown>) =>
		execute("test", params, undefined, undefined, {
			cwd: process.cwd(),
			ui: {
				notify: vi.fn(),
			},
		}) as Promise<ToolResult>;
}

describe("web_search", () => {
	it("falls back to next provider when the primary provider is rate-limited", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("api.exa.ai")) {
				return new Response(JSON.stringify({ error: "too many requests" }), {
					status: 429,
					statusText: "Too Many Requests",
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
					},
				});
			}
			if (url.includes("api.perplexity.ai")) {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "fallback answer" } }],
						citations: ["https://example.com/ref"],
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			}
			return new Response("not found", { status: 404, statusText: "Not Found" });
		});

		const execute = setupTool({
			fetchImpl: fetchMock as unknown as typeof fetch,
			keys: createKeys("exa-key", "perplexity-key"),
		});

		const result = await execute({
			query: "Bun spawn docs",
			mode: "resources",
		});

		expect(result.isError).toBeFalsy();
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("Recovered after provider fallback");
		expect(text).toContain("exa: exa rate limit exceeded; retry after ~60s");
		expect(text).toContain("Provider: perplexity");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not fallback when provider is explicitly forced", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("api.exa.ai")) {
				return new Response(JSON.stringify({ error: "too many requests" }), {
					status: 429,
					statusText: "Too Many Requests",
					headers: {
						"content-type": "application/json",
						"retry-after": "30",
					},
				});
			}
			if (url.includes("api.perplexity.ai")) {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "should not be used" } }],
						citations: ["https://example.com"],
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			}
			return new Response("not found", { status: 404, statusText: "Not Found" });
		});

		const execute = setupTool({
			fetchImpl: fetchMock as unknown as typeof fetch,
			keys: createKeys("exa-key", "perplexity-key"),
		});

		const result = await execute({
			query: "rate limit test",
			provider: "exa",
		});

		expect(result.isError).toBe(true);
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("web_search failed after trying exa");
		expect(text).toContain("retry after ~30s");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.exa.ai");
	});
});
