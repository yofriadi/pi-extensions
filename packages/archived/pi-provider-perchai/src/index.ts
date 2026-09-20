import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { probeCliSession } from "./auth/cli-session.ts";
import type { PerchCredentials } from "./auth/perch-oauth.ts";
import { loginPerch, refreshTokens } from "./auth/perch-oauth.ts";
import { PerchError } from "./errors.ts";
import { convertContext } from "./messages.ts";
import { buildModelCallRequest, type PerchStreamCredentials, postModelCall } from "./model-call.ts";
import { PERCH_MODELS, perchModelMeta } from "./models.ts";
import { translatePerchStream } from "./perch-stream.ts";

const PERCH_API = "perch";
const PERCH_BASE_URL = "https://app.perchai.app";
const PERCH_PROVIDER_NAME = "Perch AI";
const POLICY_DISCLOSURE =
	"Perch's internal endpoints are not a public API. This unofficial integration may be blocked or rate limited, and using it could risk account suspension. Do you accept this risk?";

/** pi ThinkingLevel → Perch effort.level + roostReasoning (design table). */
function effortFor(reasoning: SimpleStreamOptions["reasoning"]): {
	level: "off" | "low" | "medium" | "high" | "xhigh" | "max";
	roostReasoning: boolean;
} {
	switch (reasoning) {
		case "minimal":
		case "low":
			return { level: "low", roostReasoning: true };
		case "medium":
			return { level: "medium", roostReasoning: true };
		case "high":
			return { level: "high", roostReasoning: true };
		case "xhigh":
			return { level: "xhigh", roostReasoning: true };
		case "max":
			return { level: "max", roostReasoning: true };
		default:
			return { level: "off", roostReasoning: false };
	}
}

function parseStreamCredentials(apiKey: string | undefined): PerchStreamCredentials {
	if (typeof apiKey !== "string" || apiKey.length === 0) {
		throw new PerchError({ message: "perch: not logged in — run /login and select Perch" });
	}
	try {
		const parsed = JSON.parse(apiKey) as { access?: unknown; appUrl?: unknown };
		if (typeof parsed.access !== "string" || typeof parsed.appUrl !== "string") {
			throw new Error("missing fields");
		}
		return { access: parsed.access, appUrl: parsed.appUrl };
	} catch (error) {
		if (error instanceof PerchError) throw error;
		throw new PerchError({ message: "perch: stored credentials are malformed — log in again with /login" });
	}
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Terminal error without an HTTP request (bad credentials, unknown model). */
function failStream(model: Model<string>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error });
	stream.end(error);
	return stream;
}

function streamSimplePerch(
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const meta = perchModelMeta[model.id];
	if (meta === undefined) {
		return failStream(model, `perch: unknown model id "${model.id}"`);
	}

	let credentials: PerchStreamCredentials;
	try {
		credentials = parseStreamCredentials(options?.apiKey);
	} catch (error) {
		return failStream(model, error instanceof PerchError ? error.message : String(error));
	}

	const effort = effortFor(options?.reasoning);
	const converted = convertContext(context);
	const signal = options?.signal ?? new AbortController().signal;

	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			const request = await buildModelCallRequest(
				credentials,
				converted,
				effort,
				meta.roostModelChoice,
				meta.manualModelOptionId,
				options?.temperature,
				options?.maxTokens,
				signal,
			);
			const response = await postModelCall(credentials, request, model, {
				onPayload: options?.onPayload,
				onResponse: options?.onResponse,
				signal,
			});
			if (response.body === null) {
				throw new PerchError({ message: "perch: model call returned an empty body" });
			}
			const upstream = translatePerchStream(response.body, model, signal);
			for await (const event of upstream) {
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: signal.aborted ? "aborted" : "error",
				errorMessage:
					error instanceof PerchError
						? error.message
						: error instanceof Error
							? error.message
							: String(error),
				timestamp: Date.now(),
			};
			stream.push({
				type: "error",
				reason: signal.aborted ? "aborted" : "error",
				error: message,
			});
			stream.end(message);
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("perch", {
		name: PERCH_PROVIDER_NAME,
		baseUrl: PERCH_BASE_URL,
		api: PERCH_API,
		streamSimple: streamSimplePerch,
		oauth: makePerchOauth(),
		models: PERCH_MODELS,
	});
}

function makePerchOauth(): NonNullable<ProviderConfig["oauth"]> {
	return {
		name: PERCH_PROVIDER_NAME,
		isSubscription: true,
		login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
			const accepted = await callbacks.onSelect({
				message: POLICY_DISCLOSURE,
				options: [
					{ id: "accept", label: "Accept and continue" },
					{ id: "cancel", label: "Cancel" },
				],
			});
			if (accepted !== "accept") {
				throw new PerchError({ message: "perch: login cancelled (policy risk not accepted)" });
			}
			// CLI-session import first (design §CLI session import): offer the
			// choice when a local `perch login` session exists.
			const probe = await probeCliSession();
			for (const warning of probe.warnings) {
				callbacks.onProgress?.(`perch: CLI session not imported — ${warning}; continuing with browser login`);
			}
			const session = probe.session;
			if (session !== null) {
				const selection = await callbacks.onSelect({
					message: `Found a perch CLI session (${session.source}). Import it?`,
					options: [
						{ id: "import", label: "Import the existing session" },
						{ id: "browser", label: "Log in with the browser instead" },
					],
				});
				if (selection === "import") {
					callbacks.onProgress?.(`perch: imported CLI session (${session.source}); no browser opened`);
					return session.credentials;
				}
				if (selection !== "browser") {
					throw new PerchError({ message: "perch: login cancelled" });
				}
			}
			return loginPerch(PERCH_BASE_URL, callbacks);
		},
		refreshToken: (credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> => {
			const creds = credentials as PerchCredentials;
			if (typeof creds.refresh !== "string" || typeof creds.appUrl !== "string") {
				throw new PerchError({ message: "perch: stored credentials are malformed — log in again with /login" });
			}
			return refreshTokens(creds.refresh, creds.appUrl, signal);
		},
		getApiKey: (credentials: OAuthCredentials): string => {
			const creds = credentials as PerchCredentials;
			if (typeof creds.access !== "string" || typeof creds.appUrl !== "string") {
				throw new PerchError({ message: "perch: stored credentials are malformed — log in again with /login" });
			}
			return JSON.stringify({ access: creds.access, appUrl: creds.appUrl });
		},
	};
}
