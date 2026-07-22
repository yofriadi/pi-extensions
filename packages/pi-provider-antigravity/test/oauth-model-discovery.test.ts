import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAntigravityToken } from "../src/google-antigravity-oauth.ts";

describe("Antigravity OAuth model discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stores only public backend IDs after a successful refresh", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
				return new Response(
					JSON.stringify({
						models: {
							"gemini-3.5-flash-low": { isInternal: false },
							chat_internal: { isInternal: true },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const credentials = await refreshAntigravityToken("refresh", "project");

		expect(credentials).toMatchObject({
			refresh: "refresh",
			access: "new-access",
			projectId: "project",
			antigravityAvailableModelIds: ["gemini-3.5-flash-low"],
		});
		expect(JSON.stringify(credentials)).not.toContain("chat_internal");
	});
});
