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
	commands: Map<
		string,
		{
			description?: string;
			handler: (args: string, ctx?: unknown) => Promise<void> | void;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string; description: string }[];
		}
	>;
}

function makePi(flags: Record<string, boolean | string> = {}): PiHarness {
	const registeredFlags: PiHarness["registeredFlags"] = [];
	const handlers = new Map<string, HandlerFn>();
	const commands = new Map<string, PiHarness["commands"] extends Map<string, infer V> ? V : never>();
	const api = {
		registerFlag(name: string, options: { description?: string; type: string; default?: boolean | string }) {
			registeredFlags.push({ name, options });
		},
		getFlag: (name: string) => flags[name],
		on: (name: string, handler: HandlerFn) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx?: unknown) => Promise<void> | void;
				getArgumentCompletions?: (prefix: string) => { value: string; label: string; description: string }[];
			},
		) => {
			commands.set(name, options);
		},
	};
	return { api: api as unknown as ExtensionAPI, registeredFlags, handlers, commands };
}

async function fire(h: PiHarness, event: string, payload?: unknown): Promise<unknown> {
	const handler = h.handlers.get(event);
	expect(handler).toBeDefined();
	return handler?.(payload, undefined);
}

/** Dispatch a registered slash command with an optional UI ctx. */
async function runCommand(h: PiHarness, name: string, args = "", ctx?: unknown): Promise<void> {
	const command = h.commands.get(name);
	expect(command).toBeDefined();
	await command?.handler(args, ctx);
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

	it("turn milestone blocks fire their own files", async () => {
		useProjectSounds({
			turns: [
				{ at: 25, files: ["quarter.wav"] },
				{ at: [50, 100], files: ["big.wav"] },
			],
		});
		const h = makePi();
		piEventSounds(h.api);
		for (const turnIndex of [37, 75, 101, 125]) {
			await fire(h, "turn_start", { type: "turn_start", turnIndex });
		}
		expect(playSoundMock).not.toHaveBeenCalled();
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 25 });
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 50 });
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 100 });
		expect(playSoundMock).toHaveBeenCalledTimes(3);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "quarter.wav"));
		expect(playSoundMock.mock.calls[1]?.[0]).toBe(join(projectDir, "big.wav"));
		expect(playSoundMock.mock.calls[2]?.[0]).toBe(join(projectDir, "big.wav"));
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

describe("settle outcome routing", () => {
	function agentEndMessages(
		stopReason?: string,
		errorMessage?: string,
	): { role: string; stopReason?: string; errorMessage?: string }[] {
		return [{ role: "assistant", stopReason, errorMessage }];
	}

	it("agent_end(error) + agent_settled plays agentFailed and not agentSettled", async () => {
		useProjectSounds({ events: { agentFailed: ["fail.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("error") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "fail.wav"));
	});

	it("agent_end(error) with agentFailed unset plays the error file (D4)", async () => {
		useProjectSounds({ events: { error: ["err.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("error") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "err.wav"));
	});

	it("agent_end(aborted) + agent_settled plays nothing when agentAborted is unset (D6)", async () => {
		useProjectSounds({ events: { error: ["err.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("aborted") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("abort sound plays when agentAborted is configured", async () => {
		useProjectSounds({ events: { agentAborted: ["abort.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("aborted") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "abort.wav"));
	});

	it("failed run after a recovered retry still plays the success file (last agent_end wins)", async () => {
		// agent_start → error agent_end → agent_start → stop agent_end → agent_settled
		useProjectSounds({ events: { agentFailed: ["fail.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("error") });
		await fire(h, "agent_start", { type: "agent_start" });
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("stop") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "ok.wav"));
	});

	it("tool error earlier in the turn does not suppress the failure sound", async () => {
		useProjectSounds({ events: { error: ["err.wav"], agentFailed: ["fail.wav"], agentSettled: ["ok.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "turn_start", { type: "turn_start", turnIndex: 1 });
		await fire(h, "tool_result", { type: "tool_result", toolCallId: "c0", isError: true });
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("error") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		expect(playSoundMock).toHaveBeenCalledTimes(2);
		const played = playSoundMock.mock.calls.map((call) => call[0]);
		expect(played).toContain(join(projectDir, "err.wav"));
		expect(played).toContain(join(projectDir, "fail.wav"));
	});

	it("armed elapsed timer meeting agent_end(error) + agent_settled never fires", async () => {
		// Delta scenario: the settle handler clears the elapsed timer
		// regardless of the run outcome.
		useProjectSounds({
			events: { agentFailed: ["fail.wav"] },
			elapsed: { seconds: 0.05, repeat: false, files: ["tick.wav"] },
		});
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await fire(h, "agent_end", { type: "agent_end", messages: agentEndMessages("error") });
		await fire(h, "agent_settled", { type: "agent_settled" });
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "fail.wav"));
	});
});

describe("session mute command", () => {
	/** UI harness whose notify calls are captured for assertions. */
	function makeUi(): { ui: unknown; notifications: { message: string; type?: string }[] } {
		const notifications: { message: string; type?: string }[] = [];
		const ui = {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		};
		return { ui, notifications };
	}

	beforeEach(async () => {
		// Mute state is module scope: tests must pin a known starting point.
		const h = makePi();
		piEventSounds(h.api);
		await runCommand(h, "sounds", "on");
	});

	it("registers /sounds and /event-sounds sharing one handler", () => {
		const h = makePi();
		piEventSounds(h.api);
		expect([...h.commands.keys()].sort()).toEqual(["event-sounds", "sounds"]);
		expect(h.commands.get("sounds")?.handler).toBe(h.commands.get("event-sounds")?.handler);
	});

	it("offers on/off/status argument completions, filtered by prefix", () => {
		const h = makePi();
		piEventSounds(h.api);
		const completions = h.commands.get("sounds")?.getArgumentCompletions;
		expect(completions).toBeTypeOf("function");
		const all = completions?.("") ?? [];
		expect(all.map((item) => item.value).sort()).toEqual(["off", "on", "status"]);
		for (const item of all) {
			expect(item.label).toBe(item.value);
			expect(item.description.length).toBeGreaterThan(0);
		}
		expect((completions?.("of") ?? []).map((item) => item.value)).toEqual(["off"]);
		expect(completions?.("zzz") ?? []).toEqual([]);
	});

	it("muting silences every trigger including a timer armed earlier", async () => {
		useProjectSounds({
			events: { promptSubmit: ["yes.wav"], agentSettled: ["ok.wav"] },
			elapsed: { seconds: 0.05, repeat: false, files: ["tick.wav"] },
		});
		const h = makePi();
		piEventSounds(h.api);
		// Arm the timer unmuted, then mute before it fires.
		await fire(h, "agent_start", { type: "agent_start" });
		await runCommand(h, "sounds", "off");
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("un-muting restores playback", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await runCommand(h, "sounds", "off");
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).not.toHaveBeenCalled();
		await runCommand(h, "sounds", "on");
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "yes.wav"));
	});

	it("enabled: false or --no-sounds keeps silence after un-muting", async () => {
		useProjectSounds({ enabled: false, events: { promptSubmit: ["yes.wav"] } });
		const h1 = makePi();
		piEventSounds(h1.api);
		await runCommand(h1, "sounds", "on");
		await fire(h1, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).not.toHaveBeenCalled();

		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h2 = makePi({ "no-sounds": true });
		piEventSounds(h2.api);
		await runCommand(h2, "sounds", "on");
		await fire(h2, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("mute stays on across a session_start dispatch", async () => {
		useProjectSounds({ events: { sessionStart: ["start.wav"], promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await runCommand(h, "sounds", "off");
		await fire(h, "session_start", { type: "session_start", reason: "new" });
		expect(playSoundMock).not.toHaveBeenCalled();
		await fire(h, "input", { type: "input", text: "hi", source: "interactive" });
		expect(playSoundMock).not.toHaveBeenCalled();
	});

	it("status and unknown arguments notify without throwing", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		const ui = makeUi();
		await expect(runCommand(h, "sounds", "status", ui)).resolves.toBeUndefined();
		await expect(runCommand(h, "sounds", "bogus", ui)).resolves.toBeUndefined();
		expect(ui.notifications.length).toBe(2);
		expect(ui.notifications[0]?.message).toBe("Sounds on");
		expect(ui.notifications[1]?.message).toBe("Usage: /sounds [toggle|on|off|status]");
		expect(ui.notifications[1]?.type).toBe("warning");
	});

	it("toggle flips mute state and notifies each direction", async () => {
		useProjectSounds({ events: { promptSubmit: ["yes.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		const ui = makeUi();
		await runCommand(h, "sounds", "", ui); // default toggle
		expect(ui.notifications[0]?.message).toBe("Sounds muted for this session");
		await runCommand(h, "sounds", "toggle", ui);
		expect(ui.notifications[1]?.message).toBe("Sounds unmuted");
	});

	it("mute off silences an already-armed repeating timer until unmuted", async () => {
		useProjectSounds({
			events: { agentSettled: ["ok.wav"] },
			elapsed: { seconds: 0.03, repeat: true, files: ["tick.wav"] },
		});
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await runCommand(h, "sounds", "off");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const mutedCount = playSoundMock.mock.calls.length;
		expect(mutedCount).toBe(0);
		await runCommand(h, "sounds", "on");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(playSoundMock.mock.calls.length).toBeGreaterThan(mutedCount);
		// Stop the repeating timer so it does not leak into later tests.
		await fire(h, "agent_settled", { type: "agent_settled" });
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

	it("elapsed seconds list arms one timer per value and both fire", async () => {
		useProjectSounds({ elapsed: { seconds: [0.03, 0.06], repeat: false, files: ["tick.wav"] } });
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(playSoundMock).toHaveBeenCalledTimes(2);
		expect(playSoundMock.mock.calls.every((call) => call[0] === join(projectDir, "tick.wav"))).toBe(true);
	});

	it("elapsed blocks fire their own files at their own marks", async () => {
		useProjectSounds({
			elapsed: [
				{ seconds: 0.03, files: ["first.wav"] },
				{ seconds: 0.08, files: ["second.wav"] },
			],
		});
		const h = makePi();
		piEventSounds(h.api);
		await fire(h, "agent_start", { type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(playSoundMock).toHaveBeenCalledTimes(1);
		expect(playSoundMock.mock.calls[0]?.[0]).toBe(join(projectDir, "first.wav"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(playSoundMock).toHaveBeenCalledTimes(2);
		expect(playSoundMock.mock.calls[1]?.[0]).toBe(join(projectDir, "second.wav"));
	});
});
