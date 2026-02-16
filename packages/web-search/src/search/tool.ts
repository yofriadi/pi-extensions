import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type ResolvedWebAccessProviderKeys, resolveWebAccessProviderKeys } from "../config.js";

const WEB_SEARCH_PARAMS = Type.Object({
	query: Type.String({ description: "Search query" }),
	mode: Type.Optional(StringEnum(["auto", "resources", "answer"] as const)),
	provider: Type.Optional(StringEnum(["auto", "exa", "perplexity"] as const)),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
});

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 5;

type SearchProvider = "exa" | "perplexity";

interface ProviderAttemptFailure {
	provider: SearchProvider;
	message: string;
	rateLimited: boolean;
	retryAfterSeconds?: number;
}

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	score?: number;
}

export interface SearchResult {
	provider: SearchProvider;
	query: string;
	results: SearchResultItem[];
	answer?: string;
	citations?: string[];
	raw?: unknown;
}

export interface SearchClient {
	search(input: { query: string; limit: number; timeoutMs: number; signal?: AbortSignal }): Promise<SearchResult>;
}

export interface WebSearchToolOptions {
	fetchImpl?: typeof fetch;
	resolveKeys?: (cwd: string) => ResolvedWebAccessProviderKeys;
}

class SearchRateLimitError extends Error {
	constructor(
		readonly provider: SearchProvider,
		readonly retryAfterSeconds?: number,
	) {
		super(formatRateLimitMessage(provider, retryAfterSeconds));
		this.name = "SearchRateLimitError";
	}
}

export function registerWebSearchTool(pi: ExtensionAPI, options: WebSearchToolOptions = {}): void {
	const fetchImpl = options.fetchImpl ?? fetch;
	const resolveKeys = options.resolveKeys ?? ((cwd: string) => resolveWebAccessProviderKeys({ cwd, env: process.env }));

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using Exa (resources) or Perplexity (answers)",
		parameters: WEB_SEARCH_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			notifyStatus(ctx, `Web search started: ${params.query}`, "info");
			const keys = resolveKeys(ctx.cwd);
			const providerSelection = selectProviderChain({
				requestedProvider: params.provider,
				mode: params.mode,
				keys,
			});

			if (!providerSelection.ok) {
				notifyStatus(ctx, `Web search failed: ${providerSelection.error}`, "warning");
				return {
					isError: true,
					content: [{ type: "text", text: providerSelection.error }],
					details: {
						error: providerSelection.error,
						keys: {
							exa: keys.sources.exaApiKey,
							perplexity: keys.sources.perplexityApiKey,
						},
					},
				};
			}

			const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const limit = params.limit ?? DEFAULT_LIMIT;
			const failures: ProviderAttemptFailure[] = [];

			for (const provider of providerSelection.providers) {
				const client = createSearchClient(provider, {
					fetchImpl,
					exaApiKey: keys.exaApiKey,
					perplexityApiKey: keys.perplexityApiKey,
				});

				try {
					const result = await client.search({
						query: params.query,
						limit,
						timeoutMs,
						signal,
					});
					notifyStatus(
						ctx,
						`Web search completed via ${result.provider} (${result.results.length} result${result.results.length === 1 ? "" : "s"})`,
						"info",
					);
					return {
						content: [
							{
								type: "text",
								text: formatSearchResult(result, failures),
							},
						],
						details: {
							provider: result.provider,
							attemptedProviders: providerSelection.providers,
							forcedProvider: providerSelection.forced,
							failures,
							result,
						},
					};
				} catch (error) {
					const failure = toProviderAttemptFailure(provider, error);
					failures.push(failure);
					notifyStatus(ctx, `Web search provider ${provider} failed: ${failure.message}`, "warning");

					if (providerSelection.forced) {
						break;
					}
				}
			}

			const errorText = renderProviderFailureSummary(providerSelection.providers, failures);
			notifyStatus(ctx, `Web search failed: ${errorText}`, "warning");
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: errorText,
					},
				],
				details: {
					attemptedProviders: providerSelection.providers,
					forcedProvider: providerSelection.forced,
					failures,
					error: errorText,
				},
			};
		},
	});
}

function notifyStatus(
	ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void } } | undefined,
	message: string,
	level: "info" | "warning" | "error",
): void {
	ctx?.ui?.notify?.(message, level);
}

function formatSearchResult(result: SearchResult, failures: ProviderAttemptFailure[]): string {
	const lines: string[] = [];

	if (failures.length > 0) {
		lines.push("Recovered after provider fallback:");
		for (const failure of failures) {
			lines.push(`- ${failure.provider}: ${failure.message}`);
		}
		lines.push("");
	}

	lines.push(`Provider: ${result.provider}`, `Query: ${result.query}`);

	if (result.answer) {
		lines.push("", "Answer:", result.answer);
	}

	if (result.results.length > 0) {
		lines.push("", "Results:");
		for (const [index, item] of result.results.entries()) {
			lines.push(`${index + 1}. ${item.title}`);
			lines.push(`   ${item.url}`);
			if (item.snippet) {
				lines.push(`   ${item.snippet}`);
			}
		}
	}

	if (result.citations?.length) {
		lines.push("", `Citations: ${result.citations.join(", ")}`);
	}

	return lines.join("\n");
}

function createSearchClient(
	provider: SearchProvider,
	options: {
		fetchImpl: typeof fetch;
		exaApiKey?: string;
		perplexityApiKey?: string;
	},
): SearchClient {
	if (provider === "exa") {
		if (!options.exaApiKey) {
			throw new Error("EXA_API_KEY is not configured");
		}
		return createExaSearchClient(options.fetchImpl, options.exaApiKey);
	}

	if (!options.perplexityApiKey) {
		throw new Error("PERPLEXITY_API_KEY is not configured");
	}
	return createPerplexitySearchClient(options.fetchImpl, options.perplexityApiKey);
}

function createExaSearchClient(fetchImpl: typeof fetch, apiKey: string): SearchClient {
	return {
		async search(input): Promise<SearchResult> {
			const response = await fetchWithTimeout(
				fetchImpl,
				"https://api.exa.ai/search",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
						"x-api-key": apiKey,
						"user-agent": "pi-web-access-extension/1.0",
					},
					body: JSON.stringify({
						query: input.query,
						numResults: input.limit,
						contents: {
							text: true,
							highlights: true,
						},
					}),
					signal: input.signal,
				},
				input.timeoutMs,
				"Exa request timed out",
			);

			if (!response.ok) {
				if (response.status === 429) {
					throw new SearchRateLimitError("exa", parseRetryAfterSeconds(response.headers.get("retry-after")));
				}
				throw new Error(`Exa request failed: HTTP ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as {
				results?: Array<{
					title?: string;
					url?: string;
					text?: string;
					highlights?: string[];
					score?: number;
				}>;
			};

			const results: SearchResultItem[] = (data.results ?? [])
				.filter((entry) => !!entry.url)
				.map((entry) => ({
					title: entry.title?.trim() || entry.url || "Untitled",
					url: entry.url ?? "",
					snippet: entry.highlights?.[0] ?? entry.text,
					score: typeof entry.score === "number" ? entry.score : undefined,
				}));

			return {
				provider: "exa",
				query: input.query,
				results,
				raw: data,
			};
		},
	};
}

function createPerplexitySearchClient(fetchImpl: typeof fetch, apiKey: string): SearchClient {
	return {
		async search(input): Promise<SearchResult> {
			const response = await fetchWithTimeout(
				fetchImpl,
				"https://api.perplexity.ai/chat/completions",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
						"user-agent": "pi-web-access-extension/1.0",
					},
					body: JSON.stringify({
						model: "sonar",
						messages: [
							{
								role: "system",
								content: "You are a web search assistant. Return a concise answer with references.",
							},
							{
								role: "user",
								content: input.query,
							},
						],
						temperature: 0,
					}),
					signal: input.signal,
				},
				input.timeoutMs,
				"Perplexity request timed out",
			);

			if (!response.ok) {
				if (response.status === 429) {
					throw new SearchRateLimitError("perplexity", parseRetryAfterSeconds(response.headers.get("retry-after")));
				}
				throw new Error(`Perplexity request failed: HTTP ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as {
				choices?: Array<{
					message?: {
						content?: string;
					};
				}>;
				citations?: string[];
			};

			const answer = data.choices?.[0]?.message?.content?.trim();
			const citations = (data.citations ?? []).filter((citation) => typeof citation === "string");
			const results: SearchResultItem[] = citations.map((citation, index) => ({
				title: `Citation ${index + 1}`,
				url: citation,
			}));

			return {
				provider: "perplexity",
				query: input.query,
				answer,
				results,
				citations,
				raw: data,
			};
		},
	};
}

function selectProviderChain(input: {
	requestedProvider?: "auto" | "exa" | "perplexity";
	mode?: "auto" | "resources" | "answer";
	keys: ResolvedWebAccessProviderKeys;
}):
	| { ok: true; providers: SearchProvider[]; forced: boolean }
	| {
			ok: false;
			error: string;
	  } {
	const requested = input.requestedProvider ?? "auto";
	if (requested === "exa") {
		if (input.keys.exaApiKey) {
			return { ok: true, providers: ["exa"], forced: true };
		}
		return { ok: false, error: "web_search requested provider=exa but EXA_API_KEY is not configured." };
	}
	if (requested === "perplexity") {
		if (input.keys.perplexityApiKey) {
			return { ok: true, providers: ["perplexity"], forced: true };
		}
		return {
			ok: false,
			error: "web_search requested provider=perplexity but PERPLEXITY_API_KEY is not configured.",
		};
	}

	const mode = input.mode ?? "auto";
	const order = mode === "answer" ? (["perplexity", "exa"] as const) : (["exa", "perplexity"] as const);
	const providers = order.filter((provider) => hasProviderKey(provider, input.keys));
	if (providers.length > 0) {
		return { ok: true, providers, forced: false };
	}

	return {
		ok: false,
		error:
			"web_search is not configured. Set EXA_API_KEY or PERPLEXITY_API_KEY (or PI_EXA_API_KEY / PI_PERPLEXITY_API_KEY).",
	};
}

function hasProviderKey(provider: SearchProvider, keys: ResolvedWebAccessProviderKeys): boolean {
	if (provider === "exa") {
		return !!keys.exaApiKey;
	}
	return !!keys.perplexityApiKey;
}

function toProviderAttemptFailure(provider: SearchProvider, error: unknown): ProviderAttemptFailure {
	if (error instanceof SearchRateLimitError) {
		return {
			provider,
			message: formatRateLimitMessage(provider, error.retryAfterSeconds),
			rateLimited: true,
			retryAfterSeconds: error.retryAfterSeconds,
		};
	}
	return {
		provider,
		message: formatError(error),
		rateLimited: false,
	};
}

function renderProviderFailureSummary(providers: SearchProvider[], failures: ProviderAttemptFailure[]): string {
	const lines = [`web_search failed after trying ${providers.join(", ")}.`];
	for (const failure of failures) {
		lines.push(`- ${failure.provider}: ${failure.message}`);
	}
	return lines.join("\n");
}

function formatRateLimitMessage(provider: SearchProvider, retryAfterSeconds?: number): string {
	const prefix = `${provider} rate limit exceeded`;
	if (retryAfterSeconds === undefined) {
		return prefix;
	}
	return `${prefix}; retry after ~${retryAfterSeconds}s`;
}

function parseRetryAfterSeconds(rawHeader: string | null): number | undefined {
	if (!rawHeader) {
		return undefined;
	}

	const trimmed = rawHeader.trim();
	if (!trimmed) {
		return undefined;
	}

	if (/^\d+$/.test(trimmed)) {
		const numeric = Number.parseInt(trimmed, 10);
		if (Number.isFinite(numeric) && numeric >= 0) {
			return numeric;
		}
	}

	const asDate = Date.parse(trimmed);
	if (Number.isFinite(asDate)) {
		const deltaMs = asDate - Date.now();
		if (deltaMs <= 0) {
			return 0;
		}
		return Math.ceil(deltaMs / 1000);
	}

	return undefined;
}

async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
	const cleanup = bindAbort(init.signal, controller);

	try {
		return await fetchImpl(url, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(timeoutMessage);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		cleanup();
	}
}

function bindAbort(signal: AbortSignal | null | undefined, controller: AbortController): () => void {
	if (!signal) {
		return () => {};
	}
	if (signal.aborted) {
		controller.abort(signal.reason);
		return () => {};
	}
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
