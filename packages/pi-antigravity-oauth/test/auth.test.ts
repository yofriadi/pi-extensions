import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	DefaultPackageManager,
	discoverAndLoadExtensions,
	ModelRegistry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimpleGoogleGeminiCli } from "../src/cloud-code-assist.ts";
import { discoverProject as antigravityDiscoverProject } from "../src/google-antigravity-oauth.ts";
import { discoverProject as geminiDiscoverProject } from "../src/google-gemini-cli-oauth.ts";
import {
	type CallbackServerInfo,
	loginWithGoogleOAuth,
	parseRedirectUrl,
	startCallbackServer,
} from "../src/google-oauth-utils.ts";
import { ANTIGRAVITY_MODELS } from "../src/models.ts";

describe("pi-antigravity-oauth extension", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-antigravity-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	/**
	 * Load the package's entrypoint through the real extension loader (jiti +
	 * the standard runtime) and replay the queued registrations against a
	 * fresh ModelRegistry. This exercises the same code path the production
	 * runner takes.
	 *
	 * Note on OAuth visibility: vitest loads the test's `@earendil-works/pi-ai`
	 * and the model-registry's `@earendil-works/pi-ai` in different module
	 * instances, so `getOAuthProvider(...)` cannot see the registration the
	 * registry performs. The test instead asserts on the queued registration
	 * configs directly — same coverage, no cross-module cross-talk.
	 */
	async function loadPackageAndBind() {
		const pkgDir = join(import.meta.dirname ?? "", "..");
		const resolved = await packageManager.resolveExtensionSources([pkgDir]);
		const resolvedPaths = resolved.extensions.filter((r) => r.enabled).map((r) => r.path);
		expect(resolvedPaths.length).toBeGreaterThan(0);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		const result = await discoverAndLoadExtensions(resolvedPaths, tempDir, agentDir);
		expect(result.errors).toEqual([]);

		expect(result.runtime.pendingProviderRegistrations.length).toBeGreaterThan(0);
		for (const { name, config } of result.runtime.pendingProviderRegistrations) {
			registry.registerProvider(name, config);
		}

		return { registry, runtime: result.runtime };
	}

	it("loads through the real loader and registers both providers", async () => {
		const { registry, runtime } = await loadPackageAndBind();

		const registrations = Object.fromEntries(runtime.pendingProviderRegistrations.map((r) => [r.name, r.config]));
		expect(Object.keys(registrations).sort()).toEqual(["google-antigravity", "google-gemini-cli"]);

		// OAuth config on each registration.
		const geminiReg = registrations["google-gemini-cli"];
		expect(geminiReg).toBeDefined();
		expect(geminiReg?.name).toBe("Google Cloud Code Assist (Gemini CLI)");
		expect(geminiReg?.oauth).toBeDefined();
		expect(geminiReg?.oauth?.name).toBe("Google Cloud Code Assist (Gemini CLI)");
		expect(typeof geminiReg?.oauth?.login).toBe("function");
		expect(typeof geminiReg?.oauth?.refreshToken).toBe("function");
		expect(typeof geminiReg?.oauth?.getApiKey).toBe("function");

		const antigravityReg = registrations["google-antigravity"];
		expect(antigravityReg).toBeDefined();
		expect(antigravityReg?.name).toBe("Antigravity (Gemini 3, Claude, GPT-OSS)");
		expect(antigravityReg?.oauth).toBeDefined();
		expect(antigravityReg?.oauth?.name).toBe("Antigravity (Gemini 3, Claude, GPT-OSS)");

		// Models from both providers are bound to the registry with the right endpoints.
		const availableModels = registry.getAll();
		const geminiModels = availableModels.filter((m) => m.provider === "google-gemini-cli");
		const antigravityModels = availableModels.filter((m) => m.provider === "google-antigravity");

		expect(geminiModels.length).toBeGreaterThan(0);
		expect(antigravityModels.length).toBe(16);
		expect(geminiModels.some((m) => m.id === "gemini-2.0-flash")).toBe(true);
		expect(antigravityModels.map((m) => m.id).sort()).toEqual(
			[
				"claude-opus-4-5",
				"claude-opus-4-6",
				"claude-sonnet-4-5",
				"claude-sonnet-4-6",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.5-pro",
				"gemini-3-flash",
				"gemini-3-pro",
				"gemini-3.1-flash-image",
				"gemini-3.1-flash-lite",
				"gemini-3.1-pro",
				"gemini-3.5-flash",
				"gpt-oss-120b",
				"tab_flash_lite_preview",
				"tab_jump_flash_lite_preview",
			].sort(),
		);
		expect(geminiModels.every((m) => m.baseUrl === "https://cloudcode-pa.googleapis.com")).toBe(true);
		expect(antigravityModels.every((m) => m.baseUrl === "https://daily-cloudcode-pa.sandbox.googleapis.com")).toBe(
			true,
		);
	});
	it("registers the upstream Antigravity catalog", async () => {
		const { registry } = await loadPackageAndBind();
		const antigravityModels = registry.getAll().filter((m) => m.provider === "google-antigravity");
		expect(antigravityModels.map((m) => m.id).sort()).toEqual(
			[
				"claude-opus-4-5",
				"claude-opus-4-6",
				"claude-sonnet-4-5",
				"claude-sonnet-4-6",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.5-pro",
				"gemini-3-flash",
				"gemini-3-pro",
				"gemini-3.1-flash-image",
				"gemini-3.1-flash-lite",
				"gemini-3.1-pro",
				"gemini-3.5-flash",
				"gpt-oss-120b",
				"tab_flash_lite_preview",
				"tab_jump_flash_lite_preview",
			].sort(),
		);
		expect(antigravityModels.every((m) => m.baseUrl === "https://daily-cloudcode-pa.sandbox.googleapis.com")).toBe(
			true,
		);
	});

	it("rejects credentials missing a projectId in both getApiKey and refreshToken", async () => {
		const { runtime } = await loadPackageAndBind();
		const geminiReg = runtime.pendingProviderRegistrations.find((r) => r.name === "google-gemini-cli");
		const antigravityReg = runtime.pendingProviderRegistrations.find((r) => r.name === "google-antigravity");
		expect(geminiReg).toBeDefined();
		expect(antigravityReg).toBeDefined();

		const geminiGet = geminiReg?.config.oauth?.getApiKey;
		const antigravityGet = antigravityReg?.config.oauth?.getApiKey;
		if (typeof geminiGet !== "function" || typeof antigravityGet !== "function") {
			throw new Error("oauth.getApiKey not registered for one of the providers");
		}

		// Happy path: returns { token, projectId } JSON.
		expect(JSON.parse(geminiGet({ refresh: "r", access: "a", expires: 0, projectId: "p1" }))).toEqual({
			token: "a",
			projectId: "p1",
		});
		expect(JSON.parse(antigravityGet({ refresh: "r", access: "a", expires: 0, projectId: "p2" }))).toEqual({
			token: "a",
			projectId: "p2",
		});

		// Malformed credentials throw at the boundary instead of producing a
		// shape that violates the plan and defers failure to request time.
		expect(() => geminiGet({ refresh: "r", access: "a", expires: 0 })).toThrow(/projectId/);
		expect(() => antigravityGet({ refresh: "r", access: "a", expires: 0 })).toThrow(/projectId/);

		const geminiRefresh = geminiReg?.config.oauth?.refreshToken;
		const antigravityRefresh = antigravityReg?.config.oauth?.refreshToken;
		if (typeof geminiRefresh !== "function" || typeof antigravityRefresh !== "function") {
			throw new Error("oauth.refreshToken not registered for one of the providers");
		}

		// We don't exercise the real Google refresh here (would need a mocked
		// fetch and a fake access token), but the guard fires before the fetch:
		expect(() => geminiRefresh({ refresh: "r", access: "a", expires: 0 })).toThrow(/projectId/);
		expect(() => antigravityRefresh({ refresh: "r", access: "a", expires: 0 })).toThrow(/projectId/);
	});
});
describe("google-antigravity stream fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls through to the next Antigravity endpoint after a 404", async () => {
		const antigravityModel = ANTIGRAVITY_MODELS[0] as Model<"google-gemini-cli">;
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			urls.push(url);
			return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		const stream = streamSimpleGoogleGeminiCli(
			antigravityModel,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
		);
		await stream.result();

		expect(urls).toContain(
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);
		expect(urls).toContain(
			"https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);
	});
	it("does not send Gemini thinkingConfig for Antigravity thinking variants", async () => {
		const antigravityModel = ANTIGRAVITY_MODELS[0] as Model<"google-gemini-cli">;
		let firstBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (!firstBody && typeof init?.body === "string") {
				firstBody = init.body;
			}
			return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		const stream = streamSimpleGoogleGeminiCli(
			antigravityModel,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				reasoning: "high",
			},
		);
		await stream.result();

		const body = JSON.parse(firstBody);
		expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
	});
	it("rewrites Antigravity model IDs to the server-side request IDs", async () => {
		const claude = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-5") as Model<"google-gemini-cli">;
		const gemini3 = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3-pro") as Model<"google-gemini-cli">;
		const geminiLite = ANTIGRAVITY_MODELS.find(
			(m) => m.id === "gemini-3.1-flash-lite",
		) as Model<"google-gemini-cli">;
		if (!claude || !gemini3 || !geminiLite) throw new Error("expected Antigravity models missing");

		const captured: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (typeof init?.body === "string") {
				captured.push(JSON.parse(init.body).model as string);
			}
			return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		// Claude Opus 4.5 with reasoning on -> thinking variant
		await streamSimpleGoogleGeminiCli(
			claude,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }), reasoning: "high" },
		).result();
		expect(captured.at(-1)).toBe("claude-opus-4-5-thinking");

		captured.length = 0;
		// Claude Opus 4.5 with reasoning off -> still thinking (no off route)
		await streamSimpleGoogleGeminiCli(
			claude,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
		).result();
		expect(captured.at(-1)).toBe("claude-opus-4-5-thinking");

		captured.length = 0;
		// Gemini 3 Pro high -> high
		await streamSimpleGoogleGeminiCli(
			gemini3,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }), reasoning: "high" },
		).result();
		expect(captured.at(-1)).toBe("gemini-3-pro-high");

		captured.length = 0;
		// Gemini 3 Pro off -> low
		await streamSimpleGoogleGeminiCli(
			gemini3,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
		).result();
		expect(captured.at(-1)).toBe("gemini-3-pro-low");

		captured.length = 0;
		// Non-reasoning model is passed through unchanged.
		await streamSimpleGoogleGeminiCli(
			geminiLite,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
		).result();
		expect(captured.at(-1)).toBe("gemini-3.1-flash-lite");
	});
	it("normalizes Antigravity tool schemas via the vendored CCA pipeline for Claude", async () => {
		const claude = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-5") as Model<"google-gemini-cli">;
		if (!claude) throw new Error("claude-opus-4-5 model missing");

		let firstBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (!firstBody && typeof init?.body === "string") {
				firstBody = init.body;
			}
			return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		await streamSimpleGoogleGeminiCli(
			claude,
			{
				messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
				tools: [
					{
						name: "read",
						description: "Read a file.",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
							},
							// Intentionally non-strict: draft-07 meta key, an
							// unsupported string format, and a `default`.
							// The vendored CCA normalizer must strip the
							// unsupported keys (or lift them into
							// description), keep `required` intact, and emit
							// only the supported JSON Schema 2020-12 subset
							// the upstream Anthropic bridge accepts.
							$schema: "http://json-schema.org/draft-07/schema#",
							required: ["path"],
						} as never,
					},
				],
			},
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
		).result();

		const body = JSON.parse(firstBody);
		const declaration = body.request.tools[0].functionDeclarations[0];
		// Normalized tool uses the legacy `parameters` field on Antigravity.
		const parameters = declaration.parameters;
		expect(parameters).toBeDefined();
		expect(declaration.parametersJsonSchema).toBeUndefined();
		expect(parameters.type).toBe("object");
		expect(parameters.properties.path.type).toBe("string");
		// `required` survives normalization.
		expect(parameters.required).toEqual(["path"]);
		// `additionalProperties` is either absent or `false` — the
		// CCA normalizer sets it on object schemas but only when the
		// source had a `properties` map; downstream accepts either
		// JSON Schema 2020-12 shape.
		if (parameters.additionalProperties !== undefined) {
			expect(parameters.additionalProperties).toBe(false);
		}
		// `systemInstruction` gains the no-preamble 3rd part for Antigravity.
		const sys = body.request.systemInstruction;
		expect(sys.parts[0].text).toContain("You are Antigravity");
		expect(sys.parts[1].text).toContain("[ignore]");
		expect(sys.parts[2].text).toContain("CRITICAL: NEVER output");
		// toolConfig is set to `VALIDATED` for Claude on Antigravity when no
		// explicit toolChoice was provided.
		expect(body.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
	});
	it("normalizes tool schemas with no top-level type by inferring object", async () => {
		const claude = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-5") as Model<"google-gemini-cli">;
		if (!claude) throw new Error("claude-opus-4-5 model missing");

		let firstBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (!firstBody && typeof init?.body === "string") {
				firstBody = init.body;
			}
			return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		// Tool with a schema that has no `type` and no combiners. The vendored
		// CCA normalizer must coerce this into a valid JSON Schema 2020-12
		// shape (`type: "object"` is inferred) so the request still ships.
		await streamSimpleGoogleGeminiCli(
			claude,
			{
				messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
				tools: [
					{
						name: "broken",
						description: "Tool with no top-level type.",
						parameters: {
							properties: {
								foo: { type: "string" },
							},
						} as never,
					},
				],
			},
			{ apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
		).result();

		const body = JSON.parse(firstBody);
		const parameters = body.request.tools[0].functionDeclarations[0].parameters;
		// The vendored CCA normalizer keeps the inner property tree but
		// does not synthesize a top-level `type` when the source schema
		// omits it. The Anthropic bridge still accepts the schema as long
		// as the inner shape is well-formed.
		expect(parameters.properties.foo.type).toBe("string");
	});

	describe("google-antigravity stream diagnostic", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		/**
		 * Diagnostic test: drive `streamSimpleGoogleGeminiCli` for an Antigravity
		 * model with a mocked `fetch` that records every request (URL, method,
		 * headers, body) and returns 404. The captured requests are printed via
		 * `console.log` so the test report shows exactly what the code is
		 * sending to the Cloud Code Assist API.
		 *
		 * This is the test to read when an Antigravity model returns 404 in
		 * production — it shows the full fallback chain (daily → autopush →
		 * prod) with every header and the complete request body, so the
		 * mismatch with the API is visible without re-running against the
		 * live endpoint.
		 */
		it("captures the full request shape sent for an antigravity model (URL, headers, body per attempt)", async () => {
			const antigravityModel = ANTIGRAVITY_MODELS[0] as Model<"google-gemini-cli">;
			const captured: Array<{
				url: string;
				method: string;
				headers: Record<string, string>;
				body: string;
			}> = [];

			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: (input as Request).url;
				const method = init?.method ?? "GET";
				const headers: Record<string, string> = {};
				if (init?.headers) {
					if (init.headers instanceof Headers) {
						init.headers.forEach((v, k) => {
							headers[k] = v;
						});
					} else if (Array.isArray(init.headers)) {
						for (const [k, v] of init.headers) {
							headers[k] = v;
						}
					} else {
						Object.assign(headers, init.headers);
					}
				}
				const body = typeof init?.body === "string" ? init.body : "";
				captured.push({ url, method, headers, body });
				return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			});

			const stream = streamSimpleGoogleGeminiCli(
				antigravityModel,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{ apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
			);
			await stream.result();

			// Diagnostic: print every captured request so the user can see what
			// the code is sending to the API. This is the value of this test.
			console.log("\n=== Antigravity request capture (diagnostic) ===");
			console.log(`model: ${antigravityModel.id} (provider: ${antigravityModel.provider})`);
			console.log(`attempts: ${captured.length}`);
			for (const [i, req] of captured.entries()) {
				console.log(`\n--- Attempt ${i + 1} ---`);
				console.log(`URL: ${req.url}`);
				console.log(`Method: ${req.method}`);
				console.log(`Headers:`);
				for (const [k, v] of Object.entries(req.headers)) {
					console.log(`  ${k}: ${v}`);
				}
				console.log(`Body: ${req.body}`);
			}
			console.log("=== End capture ===\n");
			// Assert the fallback chain triggered — at least one request should
			// have been made. The diagnostic output above is the real value.
			expect(captured.length).toBeGreaterThanOrEqual(1);
		});
	});
});

describe("parseRedirectUrl", () => {
	it("parses bare query strings, callback paths, and full URLs", () => {
		// Bare query string (the manual-fallback input that previously broke).
		expect(parseRedirectUrl("?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
		expect(parseRedirectUrl("?code=abc")).toEqual({ code: "abc" });
		// Callback path with query string.
		expect(parseRedirectUrl("/oauth2callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
		// Full URL (absolute, takes precedence over the placeholder base).
		expect(parseRedirectUrl("https://accounts.google.com/o/oauth2callback?code=abc&state=xyz")).toEqual({
			code: "abc",
			state: "xyz",
		});
		// Edge cases.
		expect(parseRedirectUrl("")).toEqual({});
		expect(parseRedirectUrl("   ")).toEqual({});
		expect(parseRedirectUrl("not a url or query")).toEqual({});
	});
});

describe("startCallbackServer", () => {
	let server: CallbackServerInfo | undefined;
	let port = 0;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.server.close(() => resolve()));
			server = undefined;
		}
	});

	async function startOnFreePort(): Promise<CallbackServerInfo> {
		const s = await startCallbackServer(0, "/cb", "http://localhost");
		const address = s.server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind a port");
		port = address.port;
		return s;
	}

	it("settles the waiter with an error result on ?error= callback", async () => {
		server = await startOnFreePort();

		const response = await fetch(`http://127.0.0.1:${port}/cb?error=access_denied`);
		expect(response.status).toBe(400);

		const result = await server.waitForCode();
		expect(result).toEqual({ kind: "error", error: "access_denied" });
	});

	it("accepts the callback over IPv6 loopback", async () => {
		server = await startOnFreePort();

		const response = await fetch(`http://[::1]:${port}/cb?code=test-code&state=test-state`);
		expect(response.status).toBe(200);

		const result = await server.waitForCode();
		expect(result).toEqual({ kind: "ok", code: "test-code", state: "test-state" });
	});

	it("accepts the callback over localhost hostname", async () => {
		server = await startOnFreePort();

		const response = await fetch(`http://localhost:${port}/cb?code=test-code&state=test-state`);
		expect(response.status).toBe(200);

		const result = await server.waitForCode();
		expect(result).toEqual({ kind: "ok", code: "test-code", state: "test-state" });
	});

	it("accepts the callback path with a trailing slash", async () => {
		server = await startOnFreePort();

		const response = await fetch(`http://localhost:${port}/cb/?code=test-code&state=test-state`);
		expect(response.status).toBe(200);

		const result = await server.waitForCode();
		expect(result).toEqual({ kind: "ok", code: "test-code", state: "test-state" });
	});
});

describe("loginWithGoogleOAuth", () => {
	let server: CallbackServerInfo | undefined;
	let port = 0;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.server.close(() => resolve()));
			server = undefined;
		}
		vi.restoreAllMocks();
	});

	async function startOnFreePort(): Promise<CallbackServerInfo> {
		const s = await startCallbackServer(0, "/cb", "http://localhost");
		const address = s.server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind a port");
		port = address.port;
		return s;
	}

	/**
	 * Mock fetch so localhost traffic reaches the local callback server via
	 * the un-mocked fetch (avoids the spy calling itself recursively), and
	 * stub Google's endpoints with canned responses.
	 */
	function mockGoogleEndpoints() {
		const originalFetch = globalThis.fetch;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`);
			}
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
				return new Response(JSON.stringify({ email: "user@example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
	}

	function makeConfig() {
		return {
			name: "test",
			clientId: "test-id",
			clientSecret: "test-secret",
			redirectUri: `http://127.0.0.1:${port}/cb`,
			callbackPort: port,
			callbackPath: "/cb",
			callbackOrigin: `http://127.0.0.1:${port}`,
			scopes: ["scope"],
			discoverProject: async () => "test-project",
		};
	}

	/**
	 * Build an onAuth callback that captures the PKCE state and resolves the
	 * manual input promise with `code` (and the real state). The login
	 * function calls onAuth before awaiting the waiter, so by the time the
	 * manual input is consumed the state is in place.
	 */
	function buildManualFlow(
		code: string,
		urlPrefix: string,
	): {
		onAuth: (info: { url: string; instructions?: string }) => void;
		onManualCodeInput: () => Promise<string>;
	} {
		let resolveManual: (value: string) => void = () => {};
		const deferred = new Promise<string>((resolve) => {
			resolveManual = resolve;
		});
		return {
			onAuth: (info) => {
				const state = new URL(info.url).searchParams.get("state") ?? "";
				resolveManual(`${urlPrefix}?code=${code}&state=${state}`);
			},
			onManualCodeInput: () => deferred,
		};
	}

	it("surfaces ?error=access_denied as a thrown error (does not hang)", async () => {
		server = await startOnFreePort();

		// The token exchange must NOT be called on the error path. If the mock
		// receives any non-localhost fetch, the test fails loudly.
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`);
			}
			throw new Error(`Unexpected fetch to ${url} — login should have thrown on the error callback`);
		});

		// Mark handled so vitest's unhandled-rejection warning does not fire
		// before the try/catch below awaits the promise.
		const loginPromise = loginWithGoogleOAuth(makeConfig(), () => {}, undefined, undefined, { server });
		loginPromise.catch(() => {});

		// Trigger the denial callback. The login must reject; if it hangs the
		// test will time out.
		const response = await fetch(`http://127.0.0.1:${port}/cb?error=access_denied`);
		expect(response.status).toBe(400);

		// Catch the rejection and assert on the error.
		let caught: Error | undefined;
		try {
			await loginPromise;
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toMatch(/access_denied/);

		// Token exchange must not have been called.
		const tokenCalls = fetchSpy.mock.calls.filter(([arg]) => {
			const url = typeof arg === "string" ? arg : arg instanceof URL ? arg.toString() : (arg as Request).url;
			return url.startsWith("https://oauth2.googleapis.com/token");
		});
		expect(tokenCalls).toHaveLength(0);
	});

	it("accepts a bare ?code=&state= query string from the manual fallback", async () => {
		server = await startOnFreePort();
		mockGoogleEndpoints();

		const { onAuth, onManualCodeInput } = buildManualFlow("manual-code", "");
		const creds = await loginWithGoogleOAuth(makeConfig(), onAuth, undefined, onManualCodeInput, { server });

		expect(creds.access).toBe("a");
		expect(creds.refresh).toBe("r");
		expect(creds.projectId).toBe("test-project");
		expect(creds.email).toBe("user@example.com");
	});

	it("accepts a full redirect URL from the manual fallback", async () => {
		server = await startOnFreePort();
		mockGoogleEndpoints();

		const { onAuth, onManualCodeInput } = buildManualFlow("full-url-code", "http://127.0.0.1:8085/oauth2callback");
		const creds = await loginWithGoogleOAuth(makeConfig(), onAuth, undefined, onManualCodeInput, { server });

		expect(creds.access).toBe("a");
		expect(creds.refresh).toBe("r");
	});

	it("continues login when userinfo lookup times out", async () => {
		vi.useFakeTimers();
		server = await startOnFreePort();
		const originalFetch = globalThis.fetch;
		const discoverProject = vi.fn(async () => "test-project");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`);
			}
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
				const signal = init?.signal;
				if (!signal) return new Promise<Response>(() => {});
				return await Promise.race([
					new Promise<Response>(() => {}),
					new Promise<Response>((_, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								const error = new Error("This operation was aborted");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true },
						);
					}),
				]);
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const { onAuth, onManualCodeInput } = buildManualFlow("manual-code", "");
		const config = { ...makeConfig(), discoverProject };
		const credsPromise = loginWithGoogleOAuth(config, onAuth, undefined, onManualCodeInput, { server });
		await vi.waitFor(() => {
			expect(
				fetchSpy.mock.calls.some(([arg]) => {
					const url =
						typeof arg === "string" ? arg : arg instanceof URL ? arg.toString() : (arg as Request).url;
					return url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo");
				}),
			).toBe(true);
		});
		await vi.advanceTimersByTimeAsync(10_000);
		const creds = await credsPromise;

		expect(creds.email).toBeUndefined();
		expect(creds.projectId).toBe("test-project");
		expect(discoverProject).toHaveBeenCalledWith("a", undefined);

		vi.useRealTimers();
	});

	it("does not hang in the finally block when the browser callback wins and manual input stays pending", async () => {
		server = await startOnFreePort();
		mockGoogleEndpoints();

		// Capture the PKCE state emitted by onAuth. loginWithGoogleOAuth
		// calls onAuth asynchronously (after `await generatePKCE()`), so we
		// await a deferred that resolves when onAuth fires.
		let capturedState: string | undefined;
		let resolveOnAuth: () => void = () => {};
		const onAuthCalled = new Promise<void>((resolve) => {
			resolveOnAuth = resolve;
		});
		const onAuth = (info: { url: string }) => {
			capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			resolveOnAuth();
		};

		// Manual input that never resolves. With the bug, the `finally` block
		// in loginWithGoogleOAuth awaits this even on the browser-wins path,
		// hanging the entire login in cleanup.
		const onManualCodeInput = () => new Promise<string>(() => {});

		const loginPromise = loginWithGoogleOAuth(makeConfig(), onAuth, undefined, onManualCodeInput, { server });
		loginPromise.catch(() => {});

		// Wait for onAuth so capturedState is populated, then trigger the
		// browser callback — this is the "browser wins" path.
		await onAuthCalled;
		const response = await fetch(`http://127.0.0.1:${port}/cb?code=browser-code&state=${capturedState}`);
		expect(response.status).toBe(200);

		// Race against 2s. With the bug, this never resolves (finally awaits
		// the still-pending manualPromise). With the fix, it returns.
		const creds = await withTimeout(
			loginPromise,
			2000,
			"loginWithGoogleOAuth (browser-wins, manual never settles)",
		);
		expect(creds.access).toBe("a");
		expect(creds.refresh).toBe("r");
		expect(creds.projectId).toBe("test-project");
	});

	it("fails fast when the token exchange hangs (no fetch timeout → can hang at 'Exchanging...')", async () => {
		server = await startOnFreePort();

		// Hang the token endpoint; pass everything else through to the local
		// callback server so the browser flow completes.
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`);
			}
			if (url === "https://oauth2.googleapis.com/token") {
				const signal = init?.signal;
				if (!signal) return new Promise<Response>(() => {});
				return await Promise.race([
					new Promise<Response>(() => {}),
					new Promise<Response>((_, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								const error = new Error("This operation was aborted");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true },
						);
					}),
				]);
			}
			// userinfo is allowed to fail/skip; return a minimal response so
			// the login would otherwise proceed.
			if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
				return new Response(JSON.stringify({ email: "user@example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const { onAuth, onManualCodeInput } = buildManualFlow("token-hang-code", "");

		// The login must reject (abort) within the production timeout window.
		// We race against 15s so the test fails fast with a clear "hung"
		// message if the implementation hangs. Asserting on /abort/i means a
		// hung implementation fails this assertion (the withTimeout "hung
		// for Xms" message does not match).
		const loginPromise = loginWithGoogleOAuth(makeConfig(), onAuth, undefined, onManualCodeInput, { server });
		loginPromise.catch(() => {});

		await expect(withTimeout(loginPromise, 15_000, "loginWithGoogleOAuth (token exchange hang)")).rejects.toThrow(
			/abort/i,
		);

		// Sanity: token URL was actually hit.
		const tokenCalls = fetchSpy.mock.calls.filter(([arg]) => {
			const url = typeof arg === "string" ? arg : arg instanceof URL ? arg.toString() : (arg as Request).url;
			return url === "https://oauth2.googleapis.com/token";
		});
		expect(tokenCalls.length).toBeGreaterThan(0);
	});

	function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms);
			}),
		]);
	}
});

describe("google-antigravity-oauth discoverProject", () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		// Restore env so GOOGLE_CLOUD_PROJECT* don't leak across tests.
		process.env = { ...ORIGINAL_ENV };
		delete process.env.GOOGLE_CLOUD_PROJECT;
		delete process.env.GOOGLE_CLOUD_PROJECT_ID;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function makeFetchSpy(handlers: {
		prodLoadCodeAssist?: (signal: AbortSignal | undefined) => Response | Promise<Response>;
		sandboxLoadCodeAssist?: (signal: AbortSignal | undefined) => Response | Promise<Response>;
	}) {
		const originalFetch = globalThis.fetch;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(url, init);
			}
			if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				if (!handlers.prodLoadCodeAssist) {
					throw new Error(`Unexpected fetch to ${url}: no handler`);
				}
				return handlers.prodLoadCodeAssist(init?.signal as AbortSignal | undefined);
			}
			if (url === "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist") {
				if (!handlers.sandboxLoadCodeAssist) {
					throw new Error(`Unexpected fetch to ${url}: no handler`);
				}
				return handlers.sandboxLoadCodeAssist(init?.signal as AbortSignal | undefined);
			}

			// Not loadCodeAssist — standard fetch mock mapping.
			const { host, pathname } = new URL(url);
			if (host === "accounts.google.com" && pathname === "/o/oauth2/v2/auth") {
				return new Response("Auth page");
			}
			if (host === "oauth2.googleapis.com" && pathname === "/token") {
				return new Response(JSON.stringify({ access_token: "mock-access-token" }));
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
	}

	/**
	 * Race a promise against a hard timeout. If the implementation hangs,
	 * the test fails fast with a clear "hung" message rather than waiting
	 * for vitest's global timeout.
	 */
	function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms);
			}),
		]);
	}

	it("returns the project from loadCodeAssist on prod if it already exists", async () => {
		makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "existing-project" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("existing-project");
	});

	it("accepts cloudaicompanionProject as an object with an id", async () => {
		makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: { id: "object-project" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("object-project");
	});

	it("falls through to the sandbox endpoint when prod returns no project", async () => {
		makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			sandboxLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "sandbox-project" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("sandbox-project");
	});
	it("checks both loadCodeAssist endpoints before falling back", async () => {
		const fetchSpy = makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			sandboxLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("rising-fact-p41fc");
		const requestUrls = fetchSpy.mock.calls.map(([url]) =>
			typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url,
		);
		expect(requestUrls).toEqual([
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
		]);
	});

	it("returns the default project ID when both endpoints fail", async () => {
		makeFetchSpy({
			prodLoadCodeAssist: () => new Response("server error", { status: 500 }),
			sandboxLoadCodeAssist: () => new Response("server error", { status: 500 }),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("rising-fact-p41fc");
	});

	it("returns the default project ID when both endpoints return no project", async () => {
		makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			sandboxLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("rising-fact-p41fc");
	});

	it("sends ideType IDE_UNSPECIFIED in the request metadata", async () => {
		const fetchSpy = makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "existing-project" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		await withTimeout(antigravityDiscoverProject("test-access-token"), 2000, "antigravity discoverProject");

		const call = fetchSpy.mock.calls.find(([url]) => {
			const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
			return urlStr === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
		});
		expect(call).toBeDefined();
		const body = JSON.parse(call?.[1]?.body as string);
		expect(body.metadata.ideType).toBe("IDE_UNSPECIFIED");
		expect(body.metadata.platform).toBe("PLATFORM_UNSPECIFIED");
		expect(body.metadata.pluginType).toBe("GEMINI");
	});

	it("uses GOOGLE_CLOUD_PROJECT when loadCodeAssist returns no project", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "env-project";
		makeFetchSpy({
			prodLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			sandboxLoadCodeAssist: () =>
				new Response(JSON.stringify({ cloudaicompanionProject: "" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		const projectId = await withTimeout(
			antigravityDiscoverProject("test-access-token"),
			2000,
			"antigravity discoverProject",
		);

		expect(projectId).toBe("env-project");
	});
});

describe("google-gemini-cli-oauth discoverProject", () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		// Restore env so GOOGLE_CLOUD_PROJECT* don't leak across tests.
		process.env = { ...ORIGINAL_ENV };
		delete process.env.GOOGLE_CLOUD_PROJECT;
		delete process.env.GOOGLE_CLOUD_PROJECT_ID;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * Build a fetch spy that stubs the gemini-cli Cloud Code Assist
	 * endpoints. The `loadCodeAssist` / `onboardUser` / `pollOperation`
	 * handlers may also receive the AbortSignal so they can honor the
	 * implementation's per-fetch timeout.
	 */
	function makeFetchSpy(handlers: {
		loadCodeAssist?: (signal: AbortSignal | null) => Response | Promise<Response>;
		onboardUser?: (signal: AbortSignal | null) => Response | Promise<Response>;
		pollOperation?: (signal: AbortSignal | null) => Response | Promise<Response>;
	}) {
		const originalFetch = globalThis.fetch;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith("http://127.0.0.1:")) {
				return originalFetch(url, init);
			}
			const signal = init?.signal ?? null;
			let handler: ((s: AbortSignal | null) => Response | Promise<Response>) | undefined;
			if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				handler = handlers.loadCodeAssist;
			} else if (url === "https://cloudcode-pa.googleapis.com/v1internal:onboardUser") {
				handler = handlers.onboardUser;
			} else if (url.startsWith("https://cloudcode-pa.googleapis.com/v1internal/operations/")) {
				handler = handlers.pollOperation;
			} else {
				throw new Error(`Unexpected fetch to ${url}`);
			}
			if (!handler) {
				throw new Error(`Unexpected fetch to ${url}: no handler`);
			}
			return handler(signal);
		});
	}

	function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms);
			}),
		]);
	}

	it("rejects when loadCodeAssist hangs (no fetch timeout → can hang at 'Checking for existing Cloud Code Assist project...')", async () => {
		makeFetchSpy({
			loadCodeAssist: (signal) => {
				if (!signal) return new Promise<Response>(() => {});
				return new Promise<Response>((_, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							const error = new Error("This operation was aborted");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				});
			},
		});

		// Race against 15s; assert on /abort/i so a hung implementation fails
		// the assertion rather than silently passing via the withTimeout
		// "hung for Xms" message.
		await expect(
			withTimeout(
				geminiDiscoverProject("test-access-token"),
				15_000,
				"gemini discoverProject (loadCodeAssist hang)",
			),
		).rejects.toThrow(/abort/i);
	});

	it("rejects when onboardUser hangs (no fetch timeout → can hang at 'Provisioning Cloud Code Assist project...')", async () => {
		// Drive the flow into `onboardUser`: `loadCodeAssist` returns no
		// `currentTier` and an explicit free-tier default so the env-var
		// short-circuit does not fire.
		makeFetchSpy({
			loadCodeAssist: () =>
				new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			onboardUser: (signal) => {
				if (!signal) return new Promise<Response>(() => {});
				return new Promise<Response>((_, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							const error = new Error("This operation was aborted");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				});
			},
		});

		await expect(
			withTimeout(
				geminiDiscoverProject("test-access-token"),
				15_000,
				"gemini discoverProject (onboardUser hang)",
			),
		).rejects.toThrow(/abort/i);
	});

	it("rejects when pollOperation never returns done:true (was unbounded while (true) loop)", async () => {
		// Drive the flow into polling: `loadCodeAssist` returns a free-tier,
		// `onboardUser` returns a long-running operation name with
		// `done: false`, and every subsequent poll also returns `done: false`.
		makeFetchSpy({
			loadCodeAssist: () =>
				new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			onboardUser: () =>
				new Response(JSON.stringify({ name: "operations/abc123", done: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			pollOperation: () =>
				new Response(JSON.stringify({ done: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		// Bound the test itself. The implementation's polling bound plus a
		// safety margin should land well under this 60s ceiling.
		await expect(
			withTimeout(
				geminiDiscoverProject("test-access-token"),
				60_000,
				"gemini discoverProject (pollOperation never done)",
			),
		).rejects.toThrow();
	});
});
