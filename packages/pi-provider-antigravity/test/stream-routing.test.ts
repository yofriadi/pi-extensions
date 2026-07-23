import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleGoogleGeminiCli } from "../src/cloud-code-assist.ts";
import { ANTIGRAVITY_MODELS } from "../src/models.ts";

const SUCCESS_STREAM = `data: ${JSON.stringify({
	response: {
		candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	},
})}\n\n`;

describe("Gemini 3.5 Flash stream routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["low", "gemini-3.5-flash-extra-low"],
		["medium", "gemini-3.5-flash-low"],
		["high", "gemini-3-flash-agent"],
	] satisfies [ThinkingLevel, string][])("routes %s through %s", async (reasoning, expectedWireModel) => {
		let payloadModel: string | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(SUCCESS_STREAM, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		);
		const model = ANTIGRAVITY_MODELS.find(
			(candidate) => candidate.id === "gemini-3.5-flash",
		) as Model<"google-gemini-cli">;

		const response = await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				reasoning,
				onPayload: (payload) => {
					if (
						payload &&
						typeof payload === "object" &&
						"model" in payload &&
						typeof payload.model === "string"
					) {
						payloadModel = payload.model;
					}
				},
			},
		).result();

		expect(payloadModel).toBe(expectedWireModel);
		expect(response.stopReason).toBe("stop");
	});

	it("can bound validation to one primary-endpoint attempt", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
		const model = ANTIGRAVITY_MODELS.find(
			(candidate) => candidate.id === "gemini-3.5-flash",
		) as Model<"google-gemini-cli">;

		const response = await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				reasoning: "low",
				antigravityValidation: {
					primaryEndpointOnly: true,
					maxAttempts: 1,
					maxEmptyStreamRetries: 0,
				},
			},
		).result();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/daily-cloudcode-pa\.googleapis\.com\//);
		expect(response.stopReason).toBe("error");
	});

	it("does not mask a quota error with a fallback endpoint 404", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
				return new Response(JSON.stringify({ error: { message: "Individual quota reached." } }), {
					status: 429,
				});
			}
			return new Response("Requested entity was not found.", { status: 404 });
		});
		const model = ANTIGRAVITY_MODELS.find(
			(candidate) => candidate.id === "gemini-3.6-flash",
		) as Model<"google-gemini-cli">;

		const response = await streamSimpleGoogleGeminiCli(
			model,
			{ messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				reasoning: "low",
				antigravityValidation: { maxAttempts: 2, maxEmptyStreamRetries: 0 },
			},
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toMatch(/429.*quota|quota.*429/i);
	});
});
