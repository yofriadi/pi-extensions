import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

const GOOGLE_GEMINI_CLI_API = "google-gemini-cli" as Api;

/**
 * Per-model request-time routing for Antigravity.
 *
 * Antigravity exposes public catalog IDs (e.g. `claude-opus-4-5`) that
 * differ from the server-side model IDs the Cloud Code Assist API
 * actually accepts. The public ID is what the user picks from the model
 * list; the request ID below is what we put in the request body. The
 * API rejects unknown IDs with `404: Requested entity was not found.`
 *
 * The `effortRouting` map translates the user's chosen pi `ThinkingLevel`
 * (or the `off` pseudo-level) into a request model ID. Keys:
 *  - `off`    — request ID when reasoning is disabled
 *  - `minimal`, `low`, `medium`, `high` — request ID per effort level
 * Missing effort keys fall back to a close neighbour (off ↔ minimal/low)
 * and finally to `defaultRequestId` / `id`.
 */
interface AntigravityRouting {
	off?: string;
	routing?: Partial<Record<ThinkingLevel, string>>;
	defaultRequestId?: string;
}

const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
	"claude-opus-4-5": {
		routing: {
			minimal: "claude-opus-4-5-thinking",
			low: "claude-opus-4-5-thinking",
			medium: "claude-opus-4-5-thinking",
			high: "claude-opus-4-5-thinking",
		},
		defaultRequestId: "claude-opus-4-5-thinking",
	},
	"claude-opus-4-6": {
		routing: {
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
		},
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-5": {
		off: "claude-sonnet-4-5",
		routing: {
			minimal: "claude-sonnet-4-5-thinking",
			low: "claude-sonnet-4-5-thinking",
			medium: "claude-sonnet-4-5-thinking",
			high: "claude-sonnet-4-5-thinking",
		},
		defaultRequestId: "claude-sonnet-4-5",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		defaultRequestId: "claude-sonnet-4-6",
	},
	"gemini-2.5-flash": {
		off: "gemini-2.5-flash",
		routing: {
			minimal: "gemini-2.5-flash-thinking",
			low: "gemini-2.5-flash-thinking",
			medium: "gemini-2.5-flash-thinking",
			high: "gemini-2.5-flash-thinking",
		},
		defaultRequestId: "gemini-2.5-flash",
	},
	"gemini-2.5-pro": {
		routing: {
			minimal: "gemini-2.5-pro",
			low: "gemini-2.5-pro",
			medium: "gemini-2.5-pro",
			high: "gemini-2.5-pro",
		},
		defaultRequestId: "gemini-2.5-pro",
	},
	"gemini-3-flash": {
		routing: {
			minimal: "gemini-3-flash-agent",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-extra-low",
			high: "gemini-3.5-flash-low",
		},
		defaultRequestId: "gemini-3.5-flash-extra-low",
	},
	"gemini-3-pro": {
		off: "gemini-3-pro-low",
		routing: {
			minimal: "gemini-3-pro-low",
			low: "gemini-3-pro-low",
			high: "gemini-3-pro-high",
		},
		defaultRequestId: "gemini-3-pro-low",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		routing: {
			minimal: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
		},
		defaultRequestId: "gemini-3.1-pro-low",
	},
	"gemini-3.1-flash-image": {
		off: "gemini-3.1-flash-image",
		defaultRequestId: "gemini-3.1-flash-image",
	},
	"gemini-2.5-flash-lite": {
		off: "gemini-2.5-flash-lite",
		defaultRequestId: "gemini-2.5-flash-lite",
	},
	"gemini-3.1-flash-lite": {
		off: "gemini-3.1-flash-lite",
		defaultRequestId: "gemini-3.1-flash-lite",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3-flash-agent",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-extra-low",
			high: "gemini-3.5-flash-low",
		},
		defaultRequestId: "gemini-3.5-flash-extra-low",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: {
			minimal: "gpt-oss-120b-medium",
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
		},
		defaultRequestId: "gpt-oss-120b-medium",
	},
	tab_flash_lite_preview: {
		off: "tab_flash_lite_preview",
		defaultRequestId: "tab_flash_lite_preview",
	},
	tab_jump_flash_lite_preview: {
		off: "tab_jump_flash_lite_preview",
		defaultRequestId: "tab_jump_flash_lite_preview",
	},
};

/**
 * Resolve the Cloud Code Assist request model ID for an Antigravity model.
 * Returns `modelId` unchanged if no routing entry exists.
 */
export function getAntigravityRequestModelId(modelId: string, effort: ThinkingLevel | "off" | undefined): string {
	const r = ANTIGRAVITY_ROUTING[modelId];
	if (!r) return modelId;
	if (effort === undefined || effort === "off") {
		return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
	}
	return r.routing?.[effort] ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
}

export const ANTIGRAVITY_MODELS: Model<Api>[] = [
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 3.1 Flash Lite (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.1-flash-image",
		name: "Gemini 3.1 Flash Image (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	},
	{
		id: "tab_flash_lite_preview",
		name: "tab_flash_lite_preview (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 4096,
	},
	{
		id: "tab_jump_flash_lite_preview",
		name: "tab_jump_flash_lite_preview (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 4096,
	},
];
