import { describe, expect, it } from "vitest";
import { isSuccessfulLiveValidation } from "../scripts/live-validation.ts";

describe("live validation result evaluation", () => {
	const success = {
		expectedWireModel: "gemini-3-flash-agent",
		payloadModel: "gemini-3-flash-agent",
		statuses: [200],
		stopReason: "stop",
		response: "OK",
	};

	it("accepts a completed primary-endpoint happy path", () => {
		expect(isSuccessfulLiveValidation(success)).toBe(true);
	});

	it("rejects an error terminal event even if an HTTP 200 emitted partial OK text", () => {
		expect(isSuccessfulLiveValidation({ ...success, stopReason: "error" })).toBe(false);
	});

	it("leaves fallback sequences outside the happy-path validator", () => {
		expect(isSuccessfulLiveValidation({ ...success, statuses: [404, 200] })).toBe(false);
	});

	it("allows explicit retry attempts without accepting failed statuses", () => {
		expect(isSuccessfulLiveValidation({ ...success, statuses: [200, 200] }, 2)).toBe(true);
		expect(isSuccessfulLiveValidation({ ...success, statuses: [500, 200] }, 2)).toBe(false);
	});
});
