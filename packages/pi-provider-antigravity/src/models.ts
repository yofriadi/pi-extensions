import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

const GOOGLE_GEMINI_CLI_API = "google-gemini-cli";
const ANTIGRAVITY_MODEL_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

/**
 * Per-model request-time routing for Antigravity.
 *
 * Antigravity exposes public catalog IDs (e.g. `gemini-3.5-flash`) that
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

type AntigravityThinkingLevel = ThinkingLevel | "off";
type AntigravityThinkingLevelMap = Partial<Record<AntigravityThinkingLevel, string | null>>;
type AntigravityModel = Model<"google-gemini-cli"> & { thinkingLevelMap: AntigravityThinkingLevelMap };

const GEMINI_FLASH_THINKING_LEVEL_MAP: AntigravityThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
};
const GEMINI_PRO_THINKING_LEVEL_MAP: AntigravityThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
};
const SINGLE_THINKING_LEVEL_MAP: AntigravityThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
};
const MEDIUM_THINKING_LEVEL_MAP: AntigravityThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: "medium",
	high: null,
};

const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		routing: {
			minimal: "gemini-3.6-flash-low",
			low: "gemini-3.6-flash-low",
			medium: "gemini-3.6-flash-medium",
			high: "gemini-3.6-flash-high",
		},
		defaultRequestId: "gemini-3.6-flash-low",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
		},
		defaultRequestId: "gemini-3.5-flash-extra-low",
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
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: {
			minimal: "claude-sonnet-4-6",
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
		},
		defaultRequestId: "claude-sonnet-4-6",
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

/** Return every backend model ID reachable from a logical Antigravity model. */
export function getAntigravityRequestModelIds(modelId: string): string[] {
	const routing = ANTIGRAVITY_ROUTING[modelId];
	if (!routing) return [modelId];
	return [
		...new Set([
			...(routing.off ? [routing.off] : []),
			...Object.values(routing.routing ?? {}).filter((id): id is string => id !== undefined),
			...(routing.defaultRequestId ? [routing.defaultRequestId] : []),
		]),
	];
}

export const ANTIGRAVITY_MODELS: AntigravityModel[] = [
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: GEMINI_FLASH_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: GEMINI_FLASH_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: GEMINI_PRO_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: SINGLE_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: SINGLE_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (Antigravity)",
		api: GOOGLE_GEMINI_CLI_API,
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_MODEL_BASE_URL,
		reasoning: true,
		thinkingLevelMap: MEDIUM_THINKING_LEVEL_MAP,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	},
];

export interface AntigravityCliSelection {
	label: string;
	logicalModelId: string;
	reasoning: ThinkingLevel;
	wireModelId: string;
}

/** Current public `agy models` choices and their directly observed wire routes. */
export const ANTIGRAVITY_CLI_SELECTIONS: AntigravityCliSelection[] = [
	{
		label: "Gemini 3.6 Flash (Low)",
		logicalModelId: "gemini-3.6-flash",
		reasoning: "low",
		wireModelId: "gemini-3.6-flash-low",
	},
	{
		label: "Gemini 3.6 Flash (Medium)",
		logicalModelId: "gemini-3.6-flash",
		reasoning: "medium",
		wireModelId: "gemini-3.6-flash-medium",
	},
	{
		label: "Gemini 3.6 Flash (High)",
		logicalModelId: "gemini-3.6-flash",
		reasoning: "high",
		wireModelId: "gemini-3.6-flash-high",
	},
	{
		label: "Gemini 3.5 Flash (Low)",
		logicalModelId: "gemini-3.5-flash",
		reasoning: "low",
		wireModelId: "gemini-3.5-flash-extra-low",
	},
	{
		label: "Gemini 3.5 Flash (Medium)",
		logicalModelId: "gemini-3.5-flash",
		reasoning: "medium",
		wireModelId: "gemini-3.5-flash-low",
	},
	{
		label: "Gemini 3.5 Flash (High)",
		logicalModelId: "gemini-3.5-flash",
		reasoning: "high",
		wireModelId: "gemini-3-flash-agent",
	},
	{
		label: "Gemini 3.1 Pro (Low)",
		logicalModelId: "gemini-3.1-pro",
		reasoning: "low",
		wireModelId: "gemini-3.1-pro-low",
	},
	{
		label: "Gemini 3.1 Pro (High)",
		logicalModelId: "gemini-3.1-pro",
		reasoning: "high",
		wireModelId: "gemini-pro-agent",
	},
	{
		label: "Claude Sonnet 4.6 (Thinking)",
		logicalModelId: "claude-sonnet-4-6",
		reasoning: "high",
		wireModelId: "claude-sonnet-4-6",
	},
	{
		label: "Claude Opus 4.6 (Thinking)",
		logicalModelId: "claude-opus-4-6",
		reasoning: "high",
		wireModelId: "claude-opus-4-6-thinking",
	},
	{
		label: "GPT-OSS 120B (Medium)",
		logicalModelId: "gpt-oss-120b",
		reasoning: "medium",
		wireModelId: "gpt-oss-120b-medium",
	},
];

const ANTIGRAVITY_CLI_MODEL_IDS = new Set([
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"gemini-3.1-pro",
	"gemini-3.6-flash",
	"gemini-3.5-flash",
	"gpt-oss-120b",
]);

/** Logical models corresponding to the current public Antigravity CLI selector. */
export const ANTIGRAVITY_CLI_MODELS = ANTIGRAVITY_MODELS.filter((model) => ANTIGRAVITY_CLI_MODEL_IDS.has(model.id));

/** Empty compatibility list: the static catalog is CLI-only. */
export const ANTIGRAVITY_EXTRA_MODELS = ANTIGRAVITY_MODELS.filter((model) => !ANTIGRAVITY_CLI_MODEL_IDS.has(model.id));
