import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type RuntimeSource = "request" | "agent" | "parent";

export interface RuntimeRequest {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface ParentRuntime {
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
}

export interface RoutingModel {
	provider: string;
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<any>["thinkingLevelMap"];
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ModelRegistryAdapter {
	find(provider: string, modelId: string): RoutingModel | undefined;
	available(): RoutingModel[];
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface ResolvedRuntimePlan {
	provider: string;
	modelId: string;
	model: string;
	thinking: ThinkingLevel;
	modelSource: RuntimeSource;
	thinkingSource: RuntimeSource;
	requestedModel?: string;
	requestedThinking?: ThinkingLevel;
	thinkingAdjustment?: {
		from: ThinkingLevel;
		to: ThinkingLevel;
		reason: "non-reasoning" | "inherited-clamp";
	};
	observed?: {
		model?: string;
		thinking?: ThinkingLevel;
	};
	runtimeMismatch?: string;
}

export class RuntimeResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResolutionError";
	}
}

export function parseExactModelRef(reference: string): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	return provider && modelId ? { provider, modelId } : undefined;
}

function toRoutingModel(value: any): RoutingModel | undefined {
	if (!value || typeof value.provider !== "string" || typeof value.id !== "string") {
		return undefined;
	}
	return {
		provider: value.provider,
		id: value.id,
		reasoning: value.reasoning ?? false,
		thinkingLevelMap: value.thinkingLevelMap,
		input: Array.isArray(value.input) ? value.input : undefined,
		contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
		maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined,
		cost: value.cost,
	};
}

export function wrapPiModelRegistry(registry: {
	find(provider: string, modelId: string): any;
	getAvailable?: () => any[];
	getAll?: () => any[];
	hasConfiguredAuth?: (model: any) => boolean;
}): ModelRegistryAdapter {
	return {
		find(provider, modelId) {
			return toRoutingModel(registry.find(provider, modelId));
		},
		available() {
			const direct = registry.getAvailable?.() ?? [];
			const source = direct.length > 0 ? direct : (registry.getAll?.() ?? []);
			const models: RoutingModel[] = [];
			const seen = new Set<string>();
			for (const raw of source) {
				const candidate = toRoutingModel(raw);
				if (!candidate) continue;
				if (direct.length === 0 && registry.hasConfiguredAuth && !registry.hasConfiguredAuth(raw)) {
					continue;
				}
				const ref = `${candidate.provider}/${candidate.id}`;
				if (seen.has(ref)) continue;
				seen.add(ref);
				models.push(candidate);
			}
			return models;
		},
		hasConfiguredAuth(model) {
			if (!registry.hasConfiguredAuth) {
				return (registry.getAvailable?.() ?? []).some(
					(candidate) => candidate.provider === model.provider && candidate.id === model.id,
				);
			}
			const original = registry.find(model.provider, model.id);
			return !!original && registry.hasConfiguredAuth(original);
		},
	};
}

function asPiModel(model: RoutingModel): Model<any> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input?.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image") ?? [
			"text",
		],
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
	};
}

function formatSupported(model: RoutingModel): string {
	const levels = getSupportedThinkingLevels(asPiModel(model));
	return levels.length > 0 ? levels.join(", ") : "(none)";
}

function selectField(
	requestValue: string | undefined,
	agentValue: string | undefined,
): { value?: string; source: RuntimeSource } {
	if (requestValue != null && requestValue !== "") {
		return { value: requestValue, source: "request" };
	}
	if (agentValue != null && agentValue !== "") {
		return { value: agentValue, source: "agent" };
	}
	return { source: "parent" };
}

type ModelResolution = {
	provider: string;
	modelId: string;
	selectedModel: RoutingModel | undefined;
	selection: { value?: string; source: RuntimeSource };
};

type ThinkingResolution = {
	thinking: ThinkingLevel;
	selection: { value?: string; source: RuntimeSource };
	adjustment?: ResolvedRuntimePlan["thinkingAdjustment"];
};

export function resolveRuntimePlan(
	request: RuntimeRequest,
	agentDefaults: RuntimeRequest,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
): ResolvedRuntimePlan {
	const model = resolveModel(request, agentDefaults, parent, registry);
	const thinking = resolveThinking(request, agentDefaults, parent, model);
	return buildRuntimePlan(model, thinking);
}

function resolveModel(
	request: RuntimeRequest,
	agentDefaults: RuntimeRequest,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
): ModelResolution {
	const selection = selectField(request.model, agentDefaults.model);
	if (!selection.value)
		return {
			provider: parent.provider,
			modelId: parent.modelId,
			selectedModel: registry.find(parent.provider, parent.modelId),
			selection,
		};
	const selectedModel = resolveRequestedModel(selection.value, registry);
	return { provider: selectedModel.provider, modelId: selectedModel.id, selectedModel, selection };
}

function resolveRequestedModel(reference: string, registry: ModelRegistryAdapter): RoutingModel {
	const parsed = parseExactModelRef(reference);
	if (!parsed) throw invalidModelReference(reference);
	const selectedModel = registry.find(parsed.provider, parsed.modelId);
	if (!selectedModel) throw unknownModelReference(reference, registry);
	if (!registry.hasConfiguredAuth(selectedModel))
		throw new RuntimeResolutionError(`model ${JSON.stringify(reference)} has no configured authentication`);
	return selectedModel;
}

function invalidModelReference(reference: string): RuntimeResolutionError {
	return new RuntimeResolutionError(
		`model ${JSON.stringify(reference)} must be an exact authenticated provider/model-id`,
	);
}

function unknownModelReference(reference: string, registry: ModelRegistryAdapter): RuntimeResolutionError {
	const alternatives = registry.available().map((model) => `${model.provider}/${model.id}`);
	return new RuntimeResolutionError(
		`unknown model ${JSON.stringify(reference)}; exact registry match required. Available: ${alternatives.join(", ") || "(none)"}`,
	);
}

function resolveThinking(
	request: RuntimeRequest,
	agentDefaults: RuntimeRequest,
	parent: ParentRuntime,
	model: ModelResolution,
): ThinkingResolution {
	const selection = selectField(request.thinking, agentDefaults.thinking);
	const preferredThinking = selection.value ?? parent.thinking;
	if (!isThinkingLevel(preferredThinking)) throw invalidThinkingLevel(preferredThinking);
	return selection.source === "parent"
		? resolveInheritedThinking(preferredThinking, selection, model)
		: resolveExplicitThinking(preferredThinking, selection, model);
}

function invalidThinkingLevel(value: string): RuntimeResolutionError {
	return new RuntimeResolutionError(
		`thinking ${JSON.stringify(value)} must be one of: ${THINKING_LEVELS.join(", ")}`,
	);
}

function resolveExplicitThinking(
	thinking: ThinkingLevel,
	selection: { value?: string; source: RuntimeSource },
	model: ModelResolution,
): ThinkingResolution {
	const selectedModel = model.selectedModel;
	if (!selectedModel) throw unavailableCapabilityError(thinking);
	const supported = getSupportedThinkingLevels(asPiModel(selectedModel));
	if (!supported.includes(thinking as ModelThinkingLevel))
		throw unsupportedThinkingError(thinking, model, selectedModel);
	return { thinking, selection };
}

function unavailableCapabilityError(thinking: ThinkingLevel): RuntimeResolutionError {
	return new RuntimeResolutionError(
		`model capability information is unavailable; cannot validate explicit thinking ${JSON.stringify(thinking)}`,
	);
}

function unsupportedThinkingError(
	thinking: ThinkingLevel,
	model: ModelResolution,
	selectedModel: RoutingModel,
): RuntimeResolutionError {
	return new RuntimeResolutionError(
		`thinking ${JSON.stringify(thinking)} is not supported by ${JSON.stringify(`${model.provider}/${model.modelId}`)}; supported: ${formatSupported(selectedModel)}`,
	);
}

function resolveInheritedThinking(
	thinking: ThinkingLevel,
	selection: { value?: string; source: RuntimeSource },
	model: ModelResolution,
): ThinkingResolution {
	if (!model.selectedModel) return { thinking, selection };
	const clamped = clampThinkingLevel(asPiModel(model.selectedModel), thinking) as ThinkingLevel;
	if (clamped === thinking) return { thinking, selection };
	return {
		thinking: clamped,
		selection,
		adjustment: {
			from: thinking,
			to: clamped,
			reason: model.selectedModel.reasoning ? "inherited-clamp" : "non-reasoning",
		},
	};
}

function buildRuntimePlan(model: ModelResolution, thinking: ThinkingResolution): ResolvedRuntimePlan {
	return {
		provider: model.provider,
		modelId: model.modelId,
		model: `${model.provider}/${model.modelId}`,
		thinking: thinking.thinking,
		modelSource: model.selection.source,
		thinkingSource: thinking.selection.source,
		...(model.selection.value ? { requestedModel: model.selection.value } : {}),
		...(thinking.selection.value ? { requestedThinking: thinking.thinking } : {}),
		...(thinking.adjustment ? { thinkingAdjustment: thinking.adjustment } : {}),
	};
}

function formatTokenCount(value: number | undefined): string | undefined {
	if (!value || value <= 0) return undefined;
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export function buildAuthenticatedModelCatalog(registry: ModelRegistryAdapter, limit = 24): string {
	const models = registry.available().sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	const visibleModels = models.slice(0, limit);
	const lines = ["Authenticated subagent models (use exact provider/model-id only):"];
	for (const model of visibleModels) {
		const supportedThinking = getSupportedThinkingLevels(asPiModel(model));
		const facts = [
			model.reasoning ? `reasoning (${supportedThinking.join("/") || "no thinking levels"})` : "non-reasoning",
			model.input?.includes("image") ? "text+image" : "text",
			formatTokenCount(model.contextWindow) ? `${formatTokenCount(model.contextWindow)} context` : undefined,
			formatTokenCount(model.maxTokens) ? `${formatTokenCount(model.maxTokens)} max output` : undefined,
		].filter(Boolean);
		lines.push(`- ${model.provider}/${model.id} — ${facts.join(", ")}`);
	}
	if (models.length === 0) lines.push("- none discovered; inherit the parent runtime");
	if (models.length > visibleModels.length) {
		lines.push(`- … ${models.length - visibleModels.length} more authenticated models omitted`);
	}
	lines.push(
		"Default: inherit the parent model and thinking. Override thinking first; override model only when task capability, speed, cost, modality, or context warrants it.",
	);
	return lines.join("\n");
}
