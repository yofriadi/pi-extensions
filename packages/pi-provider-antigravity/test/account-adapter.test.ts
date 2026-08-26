import { AccountStore, InMemoryAccountStorageBackend } from "@narumitw/pi-accounts";
import * as accountAdapterExport from "@yofriadi/pi-provider-antigravity/account-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_ACCOUNT_ADAPTER, type AntigravityOAuthCredential } from "../src/account-adapter.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const baseCredential = (extra: Record<string, unknown> = {}): AntigravityOAuthCredential => ({
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 60 * 60 * 1000,
	projectId: "proj-1",
	...extra,
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ANTIGRAVITY_ACCOUNT_ADAPTER metadata", () => {
	it("declares the provider-owned model metadata key and identity", () => {
		expect(ANTIGRAVITY_ACCOUNT_ADAPTER.id).toBe("google-antigravity");
		expect(ANTIGRAVITY_ACCOUNT_ADAPTER.displayName).toBeTruthy();
		expect(ANTIGRAVITY_ACCOUNT_ADAPTER.availableModelIdsKey).toBe("antigravityAvailableModelIds");
		expect(ANTIGRAVITY_ACCOUNT_ADAPTER.requiresApiKeyBridge).toBe(false);
	});

	it("maps logical catalog models through the wire-model routing", () => {
		const isModelAvailable = ANTIGRAVITY_ACCOUNT_ADAPTER.isModelAvailable;
		expect(isModelAvailable).toBeDefined();
		expect(isModelAvailable?.("gemini-3.7-flash", new Set(["gemini-3.7-flash-tiered"]))).toBe(true);
		expect(isModelAvailable?.("gemini-3.7-flash", new Set(["some-other-model"]))).toBe(false);
		// Unrouted model IDs match themselves.
		expect(isModelAvailable?.("unrouted-model", new Set(["unrouted-model"]))).toBe(true);
	});

	it("exports the adapter through the package account-adapter subpath", () => {
		expect(accountAdapterExport.ANTIGRAVITY_ACCOUNT_ADAPTER).toBe(ANTIGRAVITY_ACCOUNT_ADAPTER);
	});
});

describe("ANTIGRAVITY_ACCOUNT_ADAPTER toAuth serialization", () => {
	it("serializes runtime credentials as a JSON token payload", async () => {
		const auth = await ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.toAuth(baseCredential());
		expect(auth.apiKey).toBe(JSON.stringify({ token: "access-token", projectId: "proj-1" }));
	});

	it("rejects credentials without a project ID", async () => {
		const credential = baseCredential();
		delete credential.projectId;
		await expect(ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.toAuth(credential)).rejects.toThrow(/projectId/);
	});

	it.each([undefined, "", " ", " padded ", 1, { id: "project" }] as const)(
		"rejects malformed projectId %j",
		async (projectId) => {
			await expect(ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.toAuth(baseCredential({ projectId }))).rejects.toThrow(
				/projectId/,
			);
		},
	);
});

describe("ANTIGRAVITY_ACCOUNT_ADAPTER refresh metadata preservation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves projectId and model metadata when discovery is unavailable", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === TOKEN_URL) {
				return jsonResponse({ access_token: "new-access", expires_in: 3600 });
			}
			return jsonResponse({ error: "discovery unavailable" }, 500);
		});

		const credential = baseCredential({ antigravityAvailableModelIds: ["wire-a"] });
		const refreshed = (await ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.refresh(credential)) as AntigravityOAuthCredential;

		expect(refreshed.access).toBe("new-access");
		expect(refreshed.projectId).toBe("proj-1");
		expect(refreshed.antigravityAvailableModelIds).toEqual(["wire-a"]);
	});

	it("adopts refreshed model metadata and keeps rotating refresh tokens", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === TOKEN_URL) {
				return jsonResponse({
					access_token: "new-access",
					expires_in: 3600,
					refresh_token: "rotated-refresh",
				});
			}
			if (url.endsWith("/v1internal:fetchAvailableModels")) {
				return jsonResponse({ models: { "wire-b": { isInternal: false } } });
			}
			return jsonResponse({ error: "unexpected" }, 500);
		});

		const credential = baseCredential({ antigravityAvailableModelIds: ["wire-a"] });
		const refreshed = (await ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.refresh(credential)) as AntigravityOAuthCredential;

		expect(refreshed.refresh).toBe("rotated-refresh");
		expect(refreshed.projectId).toBe("proj-1");
		expect(refreshed.antigravityAvailableModelIds).toEqual(["wire-b"]);
	});

	it("rejects refresh for credentials without a project ID", async () => {
		const credential = baseCredential();
		delete credential.projectId;
		await expect(ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.refresh(credential)).rejects.toThrow(/projectId/);
	});

	it.each([undefined, "", " ", " padded ", 1, { id: "project" }] as const)(
		"rejects refresh with malformed projectId %j before making a request",
		async (projectId) => {
			await expect(ANTIGRAVITY_ACCOUNT_ADAPTER.oauth.refresh(baseCredential({ projectId }))).rejects.toThrow(
				/projectId/,
			);
		},
	);
});

describe("pi-accounts storage fallback for Antigravity credentials", () => {
	it("round-trips google-antigravity accounts through the accounts store", async () => {
		const store = new AccountStore(new InMemoryAccountStorageBackend());
		await store.updateProvider("google-antigravity", (state) => ({
			active: "work",
			accounts: { ...state.accounts, work: baseCredential({ antigravityAvailableModelIds: ["wire-a"] }) },
		}));

		const state = await store.readProviderAsync("google-antigravity");
		expect(state.active).toBe("work");
		expect(state.accounts.work).toMatchObject({
			access: "access-token",
			projectId: "proj-1",
			antigravityAvailableModelIds: ["wire-a"],
		});

		const raw = JSON.stringify(await store.readAsync());
		expect(raw).toContain("google-antigravity");
		expect(raw).toContain("antigravityAvailableModelIds");
	});
});
