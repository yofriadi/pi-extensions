import type { AuthInteraction, ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity-oauth.ts";
import { getAntigravityRequestModelIds } from "./models.ts";

export type { AccountProviderAdapter } from "@narumitw/pi-accounts";

export interface AntigravityOAuthCredential extends OAuthCredential {
	projectId?: string;
	antigravityAvailableModelIds?: string[];
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
		async refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
			const creds = credential as AntigravityOAuthCredential;
			if (!creds.projectId) {
				throw new Error("Missing projectId in google-antigravity credentials");
			}
			const refreshed = (await refreshAntigravityToken(
				creds.refresh,
				creds.projectId,
				signal,
			)) as AntigravityOAuthCredential;
			return {
				...credential,
				...refreshed,
				projectId: refreshed.projectId ?? creds.projectId,
				antigravityAvailableModelIds:
					refreshed.antigravityAvailableModelIds ?? creds.antigravityAvailableModelIds,
			};
		},
		async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
			const creds = credential as AntigravityOAuthCredential;
			if (!creds.projectId) {
				throw new Error("Missing projectId in google-antigravity credentials");
			}
			return {
				apiKey: JSON.stringify({
					token: creds.access,
					projectId: creds.projectId,
				}),
			};
		},
	},
};
