import type { Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { streamSimpleGoogleGeminiCli } from "./cloud-code-assist.ts";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity-oauth.ts";
import { loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli-oauth.ts";
import { ANTIGRAVITY_MODELS, GEMINI_CLI_MODELS } from "./models.ts";

const GOOGLE_GEMINI_CLI_API = "google-gemini-cli" satisfies Model<string>["api"];

interface GoogleOAuthCredentials extends OAuthCredentials {
	projectId?: string;
}

type GoogleLoginFn = (
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
) => Promise<OAuthCredentials>;

type GoogleRefreshFn = (refreshToken: string, projectId: string) => Promise<OAuthCredentials>;

function makeGoogleOAuthConfig(
	name: string,
	login: GoogleLoginFn,
	refresh: GoogleRefreshFn,
): NonNullable<ProviderConfig["oauth"]> {
	return {
		name,
		login: (callbacks) => login(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput),
		refreshToken: (credentials) => {
			const creds = credentials as GoogleOAuthCredentials;
			if (!creds.projectId) {
				throw new Error(`Missing projectId in ${name} credentials`);
			}
			return refresh(creds.refresh, creds.projectId);
		},
		getApiKey: (credentials) => {
			const creds = credentials as GoogleOAuthCredentials;
			if (!creds.projectId) {
				throw new Error(`Missing projectId in ${name} credentials`);
			}
			return JSON.stringify({ token: creds.access, projectId: creds.projectId });
		},
	};
}

function streamSimpleForGoogleCli(
	model: Model<string>,
	context: Parameters<typeof streamSimpleGoogleGeminiCli>[1],
	options: Parameters<typeof streamSimpleGoogleGeminiCli>[2],
) {
	if (model.api !== GOOGLE_GEMINI_CLI_API) {
		throw new Error(`Expected model api to be ${GOOGLE_GEMINI_CLI_API}, got ${model.api}`);
	}
	return streamSimpleGoogleGeminiCli(model as Model<"google-gemini-cli">, context, options);
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("google-gemini-cli", {
		name: "Google Cloud Code Assist (Gemini CLI)",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		api: GOOGLE_GEMINI_CLI_API,
		streamSimple: streamSimpleForGoogleCli,
		oauth: makeGoogleOAuthConfig("Google Cloud Code Assist (Gemini CLI)", loginGeminiCli, refreshGoogleCloudToken),
		models: GEMINI_CLI_MODELS,
	});

	pi.registerProvider("google-antigravity", {
		name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		api: GOOGLE_GEMINI_CLI_API,
		streamSimple: streamSimpleForGoogleCli,
		oauth: makeGoogleOAuthConfig(
			"Antigravity (Gemini 3, Claude, GPT-OSS)",
			loginAntigravity,
			refreshAntigravityToken,
		),
		models: ANTIGRAVITY_MODELS,
	});
}
