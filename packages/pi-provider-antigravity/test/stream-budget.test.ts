import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleGoogleGeminiCli } from "../src/cloud-code-assist.ts";
import { ANTIGRAVITY_MODELS } from "../src/models.ts";

const SUCCESS_STREAM = `data: ${JSON.stringify({
	response: {
		candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	},
})}\n\n`;

function antigravityModel(id: string): Model<"google-gemini-cli"> {
	const model = ANTIGRAVITY_MODELS.find((candidate) => candidate.id === id);
	if (!model) throw new Error(`missing test model ${id}`);
	return model as Model<"google-gemini-cli">;
}

/** Route fetch to a success stream while capturing the outgoing payload. */
function captureSuccessPayload() {
	let captured: Record<string, unknown> | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(SUCCESS_STREAM, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
	);
	return {
		getPayload: () => captured,
		onPayload: (payload: unknown) => {
			if (payload && typeof payload === "object") captured = payload as Record<string, unknown>;
		},
	};
}

describe("streamSimpleGoogleGeminiCli regression guards", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the model's full maxTokens when the caller sets no explicit cap (Claude thinking)", async () => {
		const model = antigravityModel("claude-sonnet-4-6");
		const { onPayload, getPayload } = captureSuccessPayload();

		await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				onPayload,
			},
		).result();

		const request = getPayload()?.request as { generationConfig?: { maxOutputTokens?: number } } | undefined;
		// Before the fix, `base.maxTokens || 0` turned "no cap" into `0 +
		// thinkingBudget`, capping a 64K model at 16384 output tokens.
		expect(request?.generationConfig?.maxOutputTokens).toBe(model.maxTokens);
	});

	it("still adds the thinking budget on top of an explicit caller cap", async () => {
		const model = antigravityModel("claude-sonnet-4-6");
		const { onPayload, getPayload } = captureSuccessPayload();

		await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				maxTokens: 8192,
				onPayload,
			},
		).result();

		const request = getPayload()?.request as { generationConfig?: { maxOutputTokens?: number } } | undefined;
		expect(request?.generationConfig?.maxOutputTokens).toBe(8192 + 16384);
	});

	it("does not retry a permanent 400 error (terminal HTTP error, not a network failure)", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: "Invalid JSON payload received" } }), { status: 400 }),
			);
		const model = antigravityModel("claude-sonnet-4-6");

		const response = await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				antigravityValidation: { primaryEndpointOnly: true },
			},
		).result();

		// Before the fix, the thrown terminal error fell into the network-error
		// branch and was retried `maxAttempts` times with backoff.
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toMatch(/Cloud Code Assist API error \(400\)/);
	});

	it("surfaces a contentless SAFETY finish without empty-stream retries", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					`data: ${JSON.stringify({ response: { candidates: [{ finishReason: "SAFETY" }] } })}\n\n`,
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
			);
		const response = await streamSimpleGoogleGeminiCli(
			antigravityModel("claude-sonnet-4-6"),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				antigravityValidation: { primaryEndpointOnly: true },
			},
		).result();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe('Model finished with finishReason "SAFETY"');
	});

	it("preserves a SAFETY finish reason after partial content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				`data: ${JSON.stringify({
					response: {
						candidates: [
							{ content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "SAFETY" },
						],
					},
				})}\n\n`,
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			),
		);
		const response = await streamSimpleGoogleGeminiCli(
			antigravityModel("claude-sonnet-4-6"),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				antigravityValidation: { primaryEndpointOnly: true },
			},
		).result();

		expect(response.errorMessage).toBe('Model finished with finishReason "SAFETY"');
		expect(response.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("does not retry when Retry-After exceeds maxRetryDelayMs", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "Quota exhausted" } }), {
				status: 429,
				headers: { "Retry-After": "3600" },
			}),
		);
		const response = await streamSimpleGoogleGeminiCli(
			antigravityModel("claude-sonnet-4-6"),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "t", projectId: "p" }),
				reasoning: "high",
				maxRetryDelayMs: 60_000,
				antigravityValidation: { primaryEndpointOnly: true },
			},
		).result();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(response.errorMessage).toMatch(/Server requested \d+s retry delay \(max: 60s\)/);
	});
});
