import type { Model } from "@earendil-works/pi-ai";
import { PERCH_MODEL_PINS } from "./models.generated.ts";

const PERCH_API = "perch";
const PERCH_PROVIDER = "perch";
const PERCH_BASE_URL = "https://app.perchai.app";

/**
 * Request-time routing metadata keyed by the model's bare id.
 *
 * - Roost entries carry only their `roostModelChoice` (the server auto-routes).
 * - Pinned entries carry the `manualModelOptionId` the model-call body needs.
 */
export interface PerchModelMeta {
	manualModelOptionId?: string;
	roostModelChoice: "standard" | "standard_max";
}

export const perchModelMeta: Record<string, PerchModelMeta> = {
	standard: { roostModelChoice: "standard" },
	"standard-max": { roostModelChoice: "standard_max" },
	...Object.fromEntries(
		Object.entries(PERCH_MODEL_PINS).map(([bareId, pin]) => [
			bareId,
			{ manualModelOptionId: pin.pin, roostModelChoice: "standard" } satisfies PerchModelMeta,
		]),
	),
};

type PerchModel = Model<typeof PERCH_API>;

function roostModel(id: string, name: string): PerchModel {
	return {
		id,
		name,
		api: PERCH_API,
		provider: PERCH_PROVIDER,
		baseUrl: PERCH_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	};
}

/**
 * Registered model catalog. The two Roost auto tiers come first (the
 * server picks the backing model); pinned Starter-pool entries follow,
 * one per docs-pool model with a pin in `models.generated.ts`.
 */
export const PERCH_MODELS: PerchModel[] = [
	roostModel("standard", "Perch Roost Standard"),
	roostModel("standard-max", "Perch Roost Standard Max"),
	...Object.entries(PERCH_MODEL_PINS).map(
		([bareId, pin]) =>
			({
				id: bareId,
				name: `${pin.displayName} (Perch)`,
				api: PERCH_API,
				provider: PERCH_PROVIDER,
				baseUrl: PERCH_BASE_URL,
				reasoning: pin.reasoning,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: pin.contextWindow,
				maxTokens: pin.maxOutputTokens,
			}) satisfies PerchModel,
	),
];
