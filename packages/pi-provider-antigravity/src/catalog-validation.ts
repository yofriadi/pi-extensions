import type { Api, Model } from "@earendil-works/pi-ai";
import type { DiscoveredAntigravityModel } from "./model-discovery.ts";
import { type AntigravityCliSelection, getAntigravityRequestModelIds } from "./models.ts";

export interface AntigravityCatalogValidation {
	availableModelIds: Set<string>;
	missingWireModelIds: string[];
	internalSelectionWireModelIds: string[];
}

/** Compare directly observed CLI routes against one sanitized discovery result. */
export function validateAntigravityCatalog(
	catalogModels: DiscoveredAntigravityModel[],
	selections: AntigravityCliSelection[],
): AntigravityCatalogValidation {
	const publicModels = catalogModels.filter((model) => !model.internal);
	const availableModelIds = new Set(publicModels.map((model) => model.id));
	const internalModelIds = new Set(catalogModels.filter((model) => model.internal).map((model) => model.id));
	return {
		availableModelIds,
		missingWireModelIds: [
			...new Set(selections.map((selection) => selection.wireModelId).filter((id) => !availableModelIds.has(id))),
		],
		internalSelectionWireModelIds: [
			...new Set(selections.map((selection) => selection.wireModelId).filter((id) => internalModelIds.has(id))),
		],
	};
}

export function filterAvailableAntigravityModels(
	models: Model<Api>[],
	availableModelIds: ReadonlySet<string>,
): Model<Api>[] {
	return models.filter(
		(model) =>
			model.provider !== "google-antigravity" ||
			getAntigravityRequestModelIds(model.id).some((requestId) => availableModelIds.has(requestId)),
	);
}
