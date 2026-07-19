import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Extension, ExtensionCommandContext, ExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

let tempDir: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-session-recap-test-"));
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

async function loadRecap(): Promise<{ extension: Extension; runtime: ExtensionRuntime }> {
	const result = await discoverAndLoadExtensions([join(packageRoot, "index.ts")], tempDir, agentDir);
	expect(result.errors).toEqual([]);
	const extension = result.extensions[0];
	if (!extension) throw new Error("Expected session-recap to load one extension");
	return { extension, runtime: result.runtime };
}

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: `${provider}-api`,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	};
}

function makeContext(activeModel: Model<Api>, registryModels: Model<Api>[]) {
	let calledModel: Model<Api> | undefined;
	let calledOptions: unknown;
	const streamSimple = vi.fn((model: Model<Api>, _context: unknown, options?: unknown) => {
		calledModel = model;
		calledOptions = options;
		return {
			result: async () => ({
				content: [{ type: "text", text: "Continue fixing custom provider support." }],
			}),
		};
	});
	const setWidget = vi.fn();
	const context = {
		model: activeModel,
		modelRegistry: {
			find: vi.fn((provider: string, id: string) =>
				registryModels.find((model) => model.provider === provider && model.id === id),
			),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "test-api-key",
				headers: { "x-test-header": "test-header-value" },
				env: { TEST_PROVIDER_ENV: "test-env-value" },
			})),
			getRegisteredProviderConfig: vi.fn(() => ({ streamSimple })),
		},
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Fix the recap extension." }],
					},
				},
			],
		},
		hasUI: true,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			setStatus: vi.fn(),
			setWidget,
		},
	} as unknown as ExtensionCommandContext;

	return {
		context,
		streamSimple,
		setWidget,
		calledModel: () => calledModel,
		calledOptions: () => calledOptions,
	};
}

function writeRecapModelSetting(model: string): void {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ sessionRecap: { model } }, null, 2)}\n`, "utf8");
}

describe("session-recap extension", () => {
	it("loads and registers its command and model flag", async () => {
		const { extension } = await loadRecap();

		expect(extension.commands.has("recap")).toBe(true);
		expect(extension.flags.has("recap-model")).toBe(true);
	});

	it.each([
		{
			settingModel: "custom/recap-model",
			activeModel: makeModel("active", "active-model"),
			configuredModel: makeModel("custom", "recap-model"),
		},
		{
			settingModel: "current",
			activeModel: makeModel("custom", "selected-model"),
			configuredModel: undefined,
		},
	])(
		"uses sessionRecap.model=$settingModel through the registered custom stream",
		async ({ settingModel, activeModel, configuredModel }) => {
			writeRecapModelSetting(settingModel);
			const { extension } = await loadRecap();
			const command = extension.commands.get("recap");
			if (!command) throw new Error("Expected recap command");

			const expectedModel = configuredModel ?? activeModel;
			const harness = makeContext(activeModel, configuredModel ? [configuredModel] : []);

			await command.handler("", harness.context);

			expect(harness.streamSimple).toHaveBeenCalledOnce();
			expect(harness.calledModel()).toBe(expectedModel);
			expect(harness.calledOptions()).toMatchObject({
				apiKey: "test-api-key",
				headers: { "x-test-header": "test-header-value" },
				env: { TEST_PROVIDER_ENV: "test-env-value" },
				signal: expect.any(AbortSignal),
				cacheRetention: "none",
				maxTokens: 256,
			});
			expect(harness.setWidget).toHaveBeenCalledWith(
				"session-recap",
				expect.arrayContaining(["✦ recap", "Continue fixing custom provider support."]),
				{ placement: "aboveEditor" },
			);
		},
	);

	it.each([
		{
			flagModel: "cli/recap-model",
			expectedModel: makeModel("cli", "recap-model"),
		},
		{
			flagModel: "current",
			expectedModel: makeModel("active", "selected-model"),
		},
	])("gives --recap-model=$flagModel precedence over settings", async ({ flagModel, expectedModel }) => {
		writeRecapModelSetting("settings/recap-model");
		const { extension, runtime } = await loadRecap();
		runtime.flagValues.set("recap-model", flagModel);
		const command = extension.commands.get("recap");
		if (!command) throw new Error("Expected recap command");

		const activeModel = flagModel === "current" ? expectedModel : makeModel("active", "selected-model");
		const harness = makeContext(activeModel, [expectedModel, makeModel("settings", "recap-model")]);

		await command.handler("", harness.context);

		expect(harness.calledModel()).toBe(expectedModel);
	});
});
