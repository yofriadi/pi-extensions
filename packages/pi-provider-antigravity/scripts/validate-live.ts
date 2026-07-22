import { validateAntigravityCatalog } from "../src/catalog-validation.ts";
import { streamSimpleGoogleGeminiCli } from "../src/cloud-code-assist.ts";
import { discoverAntigravityModels } from "../src/model-discovery.ts";
import { ANTIGRAVITY_CLI_MODELS, ANTIGRAVITY_CLI_SELECTIONS } from "../src/models.ts";
import { loadLiveAntigravityCredentials } from "../src/stored-credentials.ts";
import { isSuccessfulLiveValidation } from "./live-validation.ts";

if (process.env.ANTIGRAVITY_LIVE !== "1") {
	throw new Error("Set ANTIGRAVITY_LIVE=1 to run quota-consuming live validation");
}

function liveAttemptCount(): number {
	const raw = process.env.ANTIGRAVITY_LIVE_ATTEMPTS;
	if (raw === undefined) return 1;
	const count = Number(raw);
	if (!Number.isSafeInteger(count) || count < 1 || count > 3) {
		throw new Error("ANTIGRAVITY_LIVE_ATTEMPTS must be an integer from 1 to 3");
	}
	return count;
}

const allowedAttemptCount = liveAttemptCount();

const { accessToken, projectId } = await loadLiveAntigravityCredentials();
const catalog = await discoverAntigravityModels({
	accessToken,
	signal: AbortSignal.timeout(30_000),
});
const catalogValidation = validateAntigravityCatalog(catalog.models, ANTIGRAVITY_CLI_SELECTIONS);
if (catalogValidation.missingWireModelIds.length > 0) {
	throw new Error(`Current account catalog is missing: ${catalogValidation.missingWireModelIds.join(", ")}`);
}
if (catalogValidation.internalSelectionWireModelIds.length > 0) {
	throw new Error(
		`Current CLI selection unexpectedly resolves to internal models: ${catalogValidation.internalSelectionWireModelIds.join(", ")}`,
	);
}

const apiKey = JSON.stringify({ token: accessToken, projectId });
const results = [];
for (const testCase of ANTIGRAVITY_CLI_SELECTIONS) {
	const model = ANTIGRAVITY_CLI_MODELS.find((candidate) => candidate.id === testCase.logicalModelId);
	if (!model) throw new Error(`Missing logical model ${testCase.logicalModelId}`);
	let payloadModel: string | undefined;
	const statuses: number[] = [];
	const response = await streamSimpleGoogleGeminiCli(
		model,
		{ messages: [{ role: "user", content: "Reply with exactly OK.", timestamp: Date.now() }] },
		{
			apiKey,
			reasoning: testCase.reasoning,
			maxTokens: 16_384,
			signal: AbortSignal.timeout(180_000),
			antigravityValidation: {
				primaryEndpointOnly: true,
				maxAttempts: allowedAttemptCount,
				maxEmptyStreamRetries: 0,
			},
			onPayload: (payload) => {
				if (payload && typeof payload === "object" && "model" in payload && typeof payload.model === "string") {
					payloadModel = payload.model;
				}
			},
			onResponse: ({ status }) => {
				statuses.push(status);
			},
		},
	).result();
	const text = response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const passed = isSuccessfulLiveValidation(
		{
			expectedWireModel: testCase.wireModelId,
			payloadModel,
			statuses,
			stopReason: response.stopReason,
			response: text,
		},
		allowedAttemptCount,
	);
	results.push({
		label: testCase.label,
		expectedWireModel: testCase.wireModelId,
		payloadModel,
		statuses,
		stopReason: response.stopReason,
		response: text,
		passed,
	});
}

process.stdout.write(`${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
