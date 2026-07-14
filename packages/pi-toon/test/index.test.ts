import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BeforeAgentStartEvent,
	Extension,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adviseToon, isUniformObjectArray, JSON_SYSTEM_PROMPT, mentionsJson, objectDepth } from "../src/index.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

let tempDir: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let previousPath: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-toon-test-"));
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	rmSync(tempDir, { recursive: true, force: true });
});

async function loadToonExtension(): Promise<Extension> {
	const result = await discoverAndLoadExtensions([join(packageRoot, "src", "index.ts")], tempDir, agentDir);
	expect(result.errors).toEqual([]);
	const extension = result.extensions[0];
	if (!extension) throw new Error("Expected pi-toon to load one extension");
	return extension;
}

function getHandler(extension: Extension, eventName: string) {
	const handler = extension.handlers.get(eventName)?.[0];
	if (!handler) throw new Error(`Expected ${eventName} handler`);
	return handler;
}

function makeToonCommandsAvailable(commands: string[] = ["jaq", "jq", "toon"]): void {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	for (const command of commands) {
		const path = join(binDir, command);
		writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(path, 0o755);
	}
	process.env.PATH = `${binDir}${delimiter}/usr/bin${delimiter}/bin`;
}

function beforeAgentStartEvent(prompt: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base system prompt",
		systemPromptOptions: { cwd: tempDir },
	};
}

describe("JSON_SYSTEM_PROMPT", () => {
	it("mentions the jaq-first and jq fallback pipeline", () => {
		expect(JSON_SYSTEM_PROMPT).toContain("curl -s <url> | jaq '<query>' | toon");
		expect(JSON_SYSTEM_PROMPT).toContain("jq is the fallback");
	});

	it("teaches both encode and decode directions", () => {
		expect(JSON_SYSTEM_PROMPT).toContain("toon -d");
	});

	it("warns to keep JSON for API contracts", () => {
		expect(JSON_SYSTEM_PROMPT.toLowerCase()).toContain("contract");
	});

	it("references the bundled toon skill", () => {
		expect(JSON_SYSTEM_PROMPT).toContain("`toon` skill");
	});
});

describe("mentionsJson", () => {
	it("matches JSON-related tokens in any case", () => {
		expect(mentionsJson("parse this JSON")).toBe(true);
		expect(mentionsJson("a Json file")).toBe(true);
		expect(mentionsJson("pipe through jaq")).toBe(true);
		expect(mentionsJson("pipe through jq")).toBe(true);
		expect(mentionsJson("convert to toon")).toBe(true);
		expect(mentionsJson("a .jsonl dataset")).toBe(true);
		expect(mentionsJson("the openapi spec")).toBe(true);
		expect(mentionsJson("swagger doc")).toBe(true);
		expect(mentionsJson("some js object")).toBe(true);
	});

	it("does not match unrelated or partial words", () => {
		expect(mentionsJson("refactor the auth module")).toBe(false);
		expect(mentionsJson("adjust the layout")).toBe(false);
		expect(mentionsJson("a jsx component")).toBe(false);
		expect(mentionsJson("jsonify is a typo")).toBe(false);
	});

	it("handles empty and nullish input", () => {
		expect(mentionsJson("")).toBe(false);
		expect(mentionsJson(undefined)).toBe(false);
		expect(mentionsJson(null)).toBe(false);
	});
});

describe("TOON shape heuristics", () => {
	it("recognizes uniform, flat object arrays", () => {
		expect(
			isUniformObjectArray([
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			]),
		).toBe(true);
	});

	it("rejects non-uniform and nested object arrays", () => {
		expect(isUniformObjectArray([{ id: 1 }, { id: 2, extra: true }])).toBe(false);
		expect(
			isUniformObjectArray([
				{ id: 1, meta: { x: 1 } },
				{ id: 2, meta: { x: 2 } },
			]),
		).toBe(false);
		expect(isUniformObjectArray([])).toBe(false);
		expect(isUniformObjectArray([1, 2, 3])).toBe(false);
	});

	it("calculates nesting depth", () => {
		expect(objectDepth(42)).toBe(0);
		expect(objectDepth({ a: 1, b: 2 })).toBe(1);
		expect(objectDepth({ a: { b: { c: 1 } } })).toBe(3);
		expect(objectDepth([{ a: [1, 2] }])).toBe(3);
	});

	it("recommends TOON only for suitable JSON shapes", () => {
		expect(
			adviseToon([
				{ id: 1, role: "admin" },
				{ id: 2, role: "user" },
			]),
		).toMatchObject({ useToon: true, reason: expect.stringContaining("tabular") });
		expect(adviseToon([1, 2, 3]).useToon).toBe(true);
		expect(adviseToon({ a: 1, b: 2 }).useToon).toBe(true);
		expect(
			adviseToon([
				[1, 2],
				[3, 4],
			]),
		).toMatchObject({
			useToon: false,
			reason: expect.stringContaining("array of arrays"),
		});
		expect(adviseToon([]).useToon).toBe(false);
		expect(adviseToon({ a: { b: { c: { d: { e: 1 } } } } }, 4).useToon).toBe(false);
		expect(adviseToon([{ id: 1 }, { id: 2, extra: true }]).useToon).toBe(false);
		expect(adviseToon(42).useToon).toBe(false);
		expect(adviseToon("hi").useToon).toBe(false);
		expect(adviseToon({ a: { b: 1 } }, 1).useToon).toBe(false);
		expect(adviseToon({ a: { b: 1 } }, 2).useToon).toBe(true);
	});
});

describe("pi-toon extension integration", () => {
	it("loads one extension and registers the command and lifecycle handlers", async () => {
		const extension = await loadToonExtension();

		expect(extension.commands.has("toon")).toBe(true);
		expect(extension.commands.get("toon")?.description).toBe("Toggle JSON/TOON guidance (on, off, or status)");
		expect(extension.handlers.get("before_agent_start")).toHaveLength(1);
		expect(extension.handlers.get("session_start")).toHaveLength(1);
		expect(extension.handlers.get("session_shutdown")).toHaveLength(1);
	});

	it("gates injection to enabled JSON-related prompts after the lazy binary probe", async () => {
		makeToonCommandsAvailable();
		const extension = await loadToonExtension();
		const handler = getHandler(extension, "before_agent_start");
		const ui = { notify: vi.fn(), setStatus: vi.fn() };
		const context = { ui } as unknown as ExtensionContext;

		expect(await handler(beforeAgentStartEvent("fix the auth bug"), context)).toBeUndefined();
		expect(await handler(beforeAgentStartEvent("inspect this JSON response"), context)).toEqual({
			systemPrompt: `${JSON_SYSTEM_PROMPT}\n\nUse \`jaq\` for jq-compatible JSON queries in this environment.\n\nbase system prompt`,
		});
		expect(ui.setStatus).toHaveBeenCalledWith("pi-toon", "TOON: on");
	});

	it("falls back to jq when jaq is unavailable", async () => {
		makeToonCommandsAvailable(["jq", "toon"]);
		const extension = await loadToonExtension();
		const handler = getHandler(extension, "before_agent_start");
		const context = { ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;

		const result = await handler(beforeAgentStartEvent("inspect this JSON response"), context);
		expect(result).toEqual({
			systemPrompt: `${JSON_SYSTEM_PROMPT}\n\nUse \`jq\` for jq-compatible JSON queries in this environment.\n\nbase system prompt`,
		});
	});

	it("toggles, reports, persists, and validates exact command arguments", async () => {
		const extension = await loadToonExtension();
		const command = extension.commands.get("toon");
		if (!command) throw new Error("Expected toon command");
		const ui = { notify: vi.fn(), setStatus: vi.fn() };
		const context = { ui } as unknown as ExtensionCommandContext;

		await command.handler("", context);
		expect(ui.setStatus).toHaveBeenLastCalledWith("pi-toon", "TOON: off");
		expect(JSON.parse(readFileSync(join(agentDir, "toon.json"), "utf8"))).toEqual({ enabled: false });

		const reloaded = await loadToonExtension();
		const reloadedHandler = getHandler(reloaded, "before_agent_start");
		expect(await reloadedHandler(beforeAgentStartEvent("inspect JSON"), context)).toBeUndefined();

		await command.handler("ENABLE", context);
		expect(ui.setStatus).toHaveBeenLastCalledWith("pi-toon", "TOON: on");
		expect(JSON.parse(readFileSync(join(agentDir, "toon.json"), "utf8"))).toEqual({ enabled: true });

		await command.handler("status", context);
		expect(ui.notify).toHaveBeenLastCalledWith("TOON guidance is on.", "info");
		await command.handler("on now", context);
		expect(ui.notify).toHaveBeenLastCalledWith("Usage: /toon [on|enable|off|disable|status]", "warning");
	});

	it("clears its status on session shutdown", async () => {
		const extension = await loadToonExtension();
		const handler = getHandler(extension, "session_shutdown");
		const ui = { notify: vi.fn(), setStatus: vi.fn() };
		const context = { ui } as unknown as ExtensionContext;

		await handler({ type: "session_shutdown", reason: "quit" }, context);
		expect(ui.setStatus).toHaveBeenCalledWith("pi-toon", undefined);
	});
});
