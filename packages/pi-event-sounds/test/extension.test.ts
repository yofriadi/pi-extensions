/**
 * Extension wiring unit tests with a mocked `pi` API object: each event
 * fires the expected trigger, `--no-sounds` and `enabled: false` silence
 * everything, and handlers never throw. Player spawning is observed through
 * the module seam — vi.mock on ./player (unit-level mocking is fine here;
 * loader-level coverage lives in loader.test.ts).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piEventSounds from "../src/index";
import { playSound } from "../src/player";

vi.mock("../src/player", () => ({
	detectBackend: vi.fn(() => "darwin"),
	playSound: vi.fn(),
	clampVolume: vi.fn((v: number) => v),
	resetBackendCache: vi.fn(),
}));

const playSoundMock = vi.mocked(playSound);

type HandlerFn = (event: unknown, ctx: unknown) => Promise<void> | void;

interface PiHarness {
	api: ExtensionAPI;
	registeredFlags: { name: string; options: { description?: string; type: string; default?: boolean | string } }[];
	handlers: Map<string, HandlerFn>;
}

function makePi(flags: Record<string, boolean | string> = {}): PiHarness {
	const registeredFlags: PiHarness["registeredFlags"] = [];
	const handlers = new Map<string, HandlerFn>();
	const api = {
		registerFlag(name: string, options: { description?: string; type: string; default?: boolean | string }) {
			registeredFlags.push({ name, options });
		},
		getFlag: (name: string) => flags[name],
		on: (name: string, handler: HandlerFn) => {
			handlers.set(name, handler);
		},
	};
	return { api: api as unknown as ExtensionAPI, registeredFlags, handlers };
}

async function fire(h: PiHarness, event: string, payload?: unknown): Promise<unknown> {
	const handler = h.handlers.get(event);
	expect(handler).toBeDefined();
	return handler?.(payload, undefined);
}

/** Settings root with a `sounds` block; chdir so config tests read it. */
let projectDir: string;
let savedCwd: string;
let agentDir: string;

function useProjectSounds(sounds: unknown): void {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sounds }));
}

beforeEach(() => {
	vi.clearAllMocks();
	// realpath: macOS mkdtemp yields /var/... which resolves to /private/var/...;
	// the config resolver sees the resolved cwd, so assertions must match it.
	projectDir = realpathSync(mkdtempSync(join(tmpdir(), "sounds-ext-project-")));
	agentDir = mkdtempSync(join(tmpdir(), "sounds-ext-agent-"));
	savedCwd = process.cwd();
	process.chdir(projectDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.chdir(savedCwd);
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("extension wiring", () => {
	it("registers the --no-sounds boolean flag", () => {
		const h = makePi();
		piEventSounds(h.api);
		const flag = h.registeredFlags.find((f) => f.name === "no-sounds");
		expect(flag).toBeDefined();
		expect(flag?.options.type).toBe("boolean");
		expect(flag?.options.default).toBe(false);
	});

	it("session_start fires the sessionStart trigger", async () => {
		useProjectSounds({ events: { sessionStart: ["start.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "start.wav"));
	});

	it("input fires promptSubmit for every source", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		for (const source of ["interactive", "rpc", "extension"]) {
			await fire(h, "input", { type: "input", text: "hi", source });
		}
		expect(playSoundMock).toHaveBeenCalledTimes(3);
	});

	it("agent_start fires agentStart; agent_settled fires agentSettled", async () => {
		useProjectSounds({ events: { agentStart: ["a.wav"], agentSettled: ["s.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(2);
	});

	it("ui_prompt_start fires question", async () => {
		useProjectSounds({ events: { question: ["q.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
	});

	it("tool_result with isError fires error once per turn; three errors in one turn play once", async () => {
		useProjectSounds({ events: { error: ["err.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 1 });
		for (let i = 0; i < 3; i++) {
			await fire(h, "tool_result", { type: "tool_result", toolCallId: `c${i}`, isError: true });
		}
		expect(playSoundMock).toHaveBeenCalledTimes(1);
	});

	it("tool_result without isError plays nothing", async () => {
		useProjectSounds({ events: { error: ["err.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "tool_result", { type: "tool_result", toolCallId: "c0", isError: false });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("error dedupe resets on the next turn_start", async () => {
		useProjectSounds({ events: { error: ["err.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 1 });
		await fire(h, "tool_result", { type: "tool_result", toolCallId: "c0", isError: true });
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 2 });
		await fire(h, "tool_result", { type: "tool_result", toolCallId: "c1", isError: true });
		expect(playSoundMock).toHaveBeenCalledTimes(2);
	});

	it("quota fires on assistant error text matching default patterns", async () => {
		useProjectSounds({ events: { quota: ["quota.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "message_end", {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached (429)" },
		});
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "quota.wav"));
	});

	it("quotaExhausted fires on exhaustion patterns (insufficient_quota)", async () => {
		useProjectSounds({ events: { quotaExhausted: ["exhaust.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "message_end", {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "insufficient_quota: billing limit" },
		});
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "exhaust.wav"));
	});

	it("quotaExhausted takes precedence when both pattern lists match", async () => {
		useProjectSounds({ events: { quota: ["quota.wav"], quotaExhausted: ["exhaust.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "message_end", {
			type: "message_end",
			// "quota exceeded" appears on both lists — exhaustion wins.
			message: { role: "assistant", stopReason: "error", errorMessage: "429 — quota exceeded" },
		});
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "exhaust.wav"));
	});

	it("classified kind with empty file list plays nothing", async () => {
		// quotaExhausted matches but is unconfigured; quota is configured —
		// the kind-specific list gate must suppress, not fall back to quota.
		useProjectSounds({ events: { quota: ["quota.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "message_end", {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "insufficient_quota" },
		});
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("quota stays silent on non-quota errors and successful messages", async () => {
		useProjectSounds({ events: { quota: ["quota.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "message_end", {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "Unexpected EOF" },
		});
		await fire(h, "message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("quota dedupes a retry storm (four errors within two seconds play once)", async () => {
		useProjectSounds({ events: { quota: ["quota.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		for (let i = 0; i < 4; i++) {
			await fire(h, "message_end", {
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "429 too many requests" },
			});
		}
		expect(playSoundMock).toHaveBeenCalledTimes(1);
	});

	it("turn milestone fires on turnIndex divisible by every", async () => {
		useProjectSounds({ turns: { every: 100, files: ["century.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 37 });
		expect(playSoundMock).not.toHaveBeenCalled();
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 100 });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "century.wav"));
	});

	it("unconfigured events stay silent", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});
});

describe("silencing", () => {
	it("--no-sounds silences everything despite a full config", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"], agentSettled: ["s.wav"], error: ["e.wav"] } });
		const h = makePi({ "no-sounds": true });
		piEventSounds(h.api);
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		await fire(h, "agent_settled", { type: "agent_settled" });
		await fire(h, "tool_result", { type: "tool_result", toolCallId: "c", isError: true });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("enabled: false silences everything", async () => {
		useProjectSounds({ enabled: false, events: { promptSubmit: ["yes.wav"], agentSettled: ["s.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("no settings anywhere leaves everything silent without errors", async () => {
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});
});

describe("best-effort contract", () => {
	it("no handler throws on any lifecycle event", async () => {
		useProjectSounds({
			events: { promptSubmit: ["yes.wav"] },
			turns: { every: 1, files: ["t.wav"] },
			elapsed: { seconds: 1, repeat: true, files: ["tick.wav"] },
		});
		const h = makePi();
		piEventSounds(h.api);
		await expect(
			(async () => {
				await fire(h, "session_start", { type: "session_start", reason: "new" });
				await fire(h, "input", { type: "input", text: "x", source: "interactive" });
				await fire(h, "agent_start", { type: "agent_start" });
				await fire(h, "turn_start", { type: "turn_start", turnIndex: 1 });
				await fire(h, "message_end", {
					type: "message_end",
					message: { role: "assistant", stopReason: "stop" },
				});
				await fire(h, "tool_result", { type: "tool_result", toolCallId: "c", isError: true });
				await fire(h, "agent_settled", { type: "agent_settled" });
				await fire(h, "session_shutdown", { type: "session_shutdown", reason: "quit" });
			})(),
		).resolves.toBeUndefined();
	});

	it("session_start refreshes config before evaluating sessionStart", async () => {
		// First session: no sounds configured anywhere.
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		expect(playSoundMock).not.toHaveBeenCalled();

		// Edit settings, then a new session start governs the sessionStart sound.
		useProjectSounds({ events: { sessionStart: ["start.wav"] } });
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "start.wav"));
	});

	it("re-enabling via settings takes effect on the next session_start", async () => {
		useProjectSounds({ enabled: false, events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).not.toHaveBeenCalled();

		useProjectSounds({ enabled: true, events: { promptSubmit: ["yes.wav"] } });
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
	});

	it("elapsed timer wired through the extension fires after the configured seconds", async () => {
		useProjectSounds({ elapsed: { seconds: 0.05, repeat: false, files: ["tick.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		expect(playSoundMock).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "tick.wav"));
	});

	it("elapsed timer cleared by agent_settled never fires", async () => {
		useProjectSounds({ elapsed: { seconds: 0.05, repeat: false, files: ["tick.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await fire(h, "agent_settled", { type: "agent_settled" });
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("repeating elapsed timer fires at each interval until settled", async () => {
		useProjectSounds({ elapsed: { seconds: 0.03, repeat: true, files: ["tick.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const firedOnce = playSoundMock.mock.calls.length;
		expect(firedOnce).toBeGreaterThanOrEqual(2); // fired at least twice
		await fire(h, "agent_settled", { type: "agent_settled" });
		const settledCount = playSoundMock.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(playSoundMock.mock.calls.length).toBe(settledCount); // no more fires
	});
});
