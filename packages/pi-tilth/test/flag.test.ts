/**
 * Flag wiring: `--tilth-no-hashline` disables hashline anchor annotation for
 * the session, overriding the `hashlineCompat` config key. Read-only sessions
 * (e.g. subagents without edit permission) gain nothing from edit anchors —
 * they cost tokens — so a wrapper/subagent can opt out at launch without
 * touching the shared config files.
 *
 * Mocks the ExtensionAPI surface and spies on the compat resolver (allowed
 * for plain unit tests — loader-level coverage lives in test/loader.test.ts
 * and test/interop-loader.test.ts, which prove registration through the
 * real loader).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piTilthExtension from "../src/index";
import { resolveCompatModule } from "../src/lib/hashline-bridge";

vi.mock("../src/lib/hashline-bridge", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/hashline-bridge")>();
	return {
		...actual,
		resolveCompatModule: vi.fn(actual.resolveCompatModule),
	};
});

const resolveCompatSpy = vi.mocked(resolveCompatModule);

type FlagOptions = { description?: string; type: "boolean" | "string"; default?: boolean | string };

function makePi(flags: Record<string, boolean | string> = {}) {
	const registeredFlags: { name: string; options: FlagOptions }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		registerFlag(name: string, options: FlagOptions) {
			registeredFlags.push({ name, options });
		},
		getFlag(name: string) {
			return flags[name];
		},
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(name, handler);
		},
		// All probes succeed → availability settles on "binary", no notify.
		exec: vi.fn(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false })),
	};
	return { api: api as unknown as ExtensionAPI, registeredFlags, handlers };
}

async function fireSessionStart(
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>,
) {
	const handler = handlers.get("session_start");
	expect(handler).toBeDefined();
	const notify = vi.fn();
	await handler?.(undefined, { cwd: process.cwd(), ui: { notify } } as unknown as ExtensionContext);
	return notify;
}

describe("pi-tilth — --tilth-no-hashline flag", () => {
	let agentDir: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-tilth-flag-"));
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		// Empty agent dir + empty project dir → both config files absent →
		// defaults (hashlineCompat: true), so the flag is the only variable.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		resolveCompatSpy.mockClear();
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("registers the boolean flag with a description and false default", () => {
		const { api, registeredFlags } = makePi();
		piTilthExtension(api);
		const flag = registeredFlags.find((f) => f.name === "tilth-no-hashline");
		expect(flag).toBeDefined();
		expect(flag?.options.type).toBe("boolean");
		expect(flag?.options.default).toBe(false);
		expect(flag?.options.description?.length).toBeGreaterThan(0);
	});

	it("resolves the compat module at session_start when the flag is absent", async () => {
		const { api, handlers } = makePi();
		piTilthExtension(api);
		await fireSessionStart(handlers);
		expect(resolveCompatSpy).toHaveBeenCalledTimes(1);
	});

	it("skips compat resolution entirely when the flag is set", async () => {
		const { api, handlers } = makePi({ "tilth-no-hashline": true });
		piTilthExtension(api);
		await fireSessionStart(handlers);
		expect(resolveCompatSpy).not.toHaveBeenCalled();
	});

	it("still skips compat resolution when the config disables it (no flag)", async () => {
		// Sanity that the flag only ever *narrows* behavior: config-off and
		// flag-off must agree.
		const { api, handlers } = makePi();
		piTilthExtension(api);
		// Write a global config with hashlineCompat: false.
		mkdirSync(join(agentDir, "extensions", "pi-tilth"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "pi-tilth", "config.json"), '{"hashlineCompat": false}');
		await fireSessionStart(handlers);
		expect(resolveCompatSpy).not.toHaveBeenCalled();
	});
});
