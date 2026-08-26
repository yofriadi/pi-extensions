import type { AccountProviderAdapter, AuthInteraction, ModelAuth, OAuthCredential } from "@narumitw/pi-accounts";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity-oauth.ts";
import { getAntigravityRequestModelIds } from "./models.ts";

export type { AccountProviderAdapter } from "@narumitw/pi-accounts";

export interface AntigravityOAuthCredential extends OAuthCredential {
	projectId?: string;
	antigravityAvailableModelIds?: string[];
}

// Account metadata is persisted JSON and must be validated before it is used in
// either a token refresh request or the JSON API-key bridge payload.
function requireProjectId(credential: AntigravityOAuthCredential): string {
	const projectId: unknown = credential.projectId;
	if (typeof projectId !== "string" || projectId.length === 0 || projectId.trim() !== projectId) {
		throw new Error("Missing or invalid projectId in google-antigravity credentials");
	}
	return projectId;
}

export const ANTIGRAVITY_ACCOUNT_ADAPTER: AccountProviderAdapter = {
	id: "google-antigravity",
	displayName: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	requiresApiKeyBridge: false,
	availableModelIdsKey: "antigravityAvailableModelIds",
	isModelAvailable(modelId: string, availableModelIds: ReadonlySet<string>): boolean {
		return getAntigravityRequestModelIds(modelId).some((requestId) => availableModelIds.has(requestId));
	},
	oauth: {
		async login(interaction: AuthInteraction): Promise<OAuthCredential> {
			const credentials = await loginAntigravity(
				(info) => {
					interaction.notify({
						type: "auth_url",
						url: info.url,
						instructions: info.instructions,
					});
				},
				(message) => {
					interaction.notify({
						type: "progress",
						message,
					});
				},
				async () => {
					return interaction.prompt({
						type: "manual_code",
						message: "Enter authorization code or redirect URL:",
					});
				},
			);
			return { type: "oauth", ...credentials };
		},
		async refresh(credential: OAuthCredential, _signal?: AbortSignal): Promise<OAuthCredential> {
			const creds = credential as AntigravityOAuthCredential;
			const projectId = requireProjectId(creds);
			const refreshed = (await refreshAntigravityToken(creds.refresh, projectId)) as AntigravityOAuthCredential;
			const refreshedProjectId = refreshed.projectId === undefined ? projectId : requireProjectId(refreshed);
			return {
				...credential,
				...refreshed,
				projectId: refreshedProjectId,
				antigravityAvailableModelIds:
					refreshed.antigravityAvailableModelIds ?? creds.antigravityAvailableModelIds,
			};
		},
		async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
			const creds = credential as AntigravityOAuthCredential;
			const projectId = requireProjectId(creds);
			return {
				apiKey: JSON.stringify({
					token: creds.access,
					projectId,
				}),
			};
		},
	},
};
