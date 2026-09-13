/**
 * Config unit tests: lookup precedence, defaults, normalization, malformed
 * input tolerance (spec: sound-configuration).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUOTA_PATTERNS, defaultConfig, resolveConfig } from "../src/config";

let projectRoot: string;
let agentDir: string;
let dirs: string[] = [];

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "sounds-project-"));
	agentDir = mkdtempSync(join(tmpdir(), "sounds-agent-"));
	dirs = [projectRoot, agentDir];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeProjectSettings(content: string): void {
	mkdirSync(join(projectRoot, ".pi"), { recursive: true });
	writeFileSync(join(projectRoot, ".pi", "settings.json"), content);
}

function writeGlobalSettings(content: string): void {
	writeFileSync(join(agentDir, "settings.json"), content);
}

describe("lookup precedence", () => {
	it("uses defaults when no settings file defines sounds anywhere", () => {
		const config = resolveConfig(projectRoot, agentDir);
		expect(config).toEqual(defaultConfig());
	});

	it("project sounds override global sounds", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": ["p.wav"]}}}');
		writeGlobalSettings('{"sounds": {"events": {"promptSubmit": ["g.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(projectRoot, "p.wav")]);
	});

	it("project file without a sounds key falls through to global", () => {
		writeProjectSettings('{"theme": "dark"}');
		writeGlobalSettings('{"sounds": {"events": {"agentSettled": ["g.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.agentSettled).toEqual([join(agentDir, "g.wav")]);
	});

	it("skips unreadable (malformed JSON) files without throwing", () => {
		writeProjectSettings("{ not json");
		writeGlobalSettings('{"sounds": {"volume": 0.9}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.volume).toBe(0.9);
	});
});

describe("defaults", () => {
	it("enabled, default volume, empty event lists, default quota patterns", () => {
		const config = defaultConfig();
		expect(config.enabled).toBe(true);
		expect(config.volume).toBe(0.4);
		expect(config.events.sessionStart).toEqual([]);
		expect(config.events.promptSubmit).toEqual([]);
		expect(config.events.agentStart).toEqual([]);
		expect(config.events.agentSettled).toEqual([]);
		expect(config.events.question).toEqual([]);
		expect(config.events.error).toEqual([]);
		expect(config.events.quota).toEqual([]);
		expect(config.turns).toBeUndefined();
		expect(config.elapsed).toBeUndefined();
		expect(config.quotaPatterns).toEqual(DEFAULT_QUOTA_PATTERNS);
	});
});

describe("normalization", () => {
	it("bare string becomes a one-element array", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": "~/sounds/yes.wav"}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(homedirSafe(), "sounds", "yes.wav")]);
	});

	it("tilde expands to the home directory", () => {
		writeProjectSettings('{"sounds": {"events": {"error": ["~/e.wav", "/abs/e2.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.error).toEqual([join(homedirSafe(), "e.wav"), "/abs/e2.wav"]);
	});

	it("relative paths resolve against the project root for project settings", () => {
		writeProjectSettings('{"sounds": {"events": {"sessionStart": ["s.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.sessionStart).toEqual([join(projectRoot, "s.wav")]);
	});

	it("relative paths resolve against agentDir for global settings", () => {
		writeGlobalSettings('{"sounds": {"events": {"sessionStart": ["sounds/song.wav"]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.sessionStart).toEqual([join(agentDir, "sounds", "song.wav")]);
	});

	it("clamps out-of-range volume into 0..1", () => {
		writeProjectSettings('{"sounds": {"volume": 2.5}}');
		expect(resolveConfig(projectRoot, agentDir).volume).toBe(1);
		writeProjectSettings('{"sounds": {"volume": -3}}');
		expect(resolveConfig(projectRoot, agentDir).volume).toBe(0);
	});

	it("accepts turns and elapsed blocks", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"every": 50, "files": ["t.wav"]}, "elapsed": {"seconds": 300, "repeat": true, "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toEqual({ every: 50, files: [join(projectRoot, "t.wav")] });
		expect(config.elapsed).toEqual({ seconds: 300, repeat: true, files: [join(projectRoot, "e.wav")] });
	});

	it("replaces default quotaPatterns with a configured array", () => {
		writeProjectSettings('{"sounds": {"quotaPatterns": ["custom", "patterns"]}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.quotaPatterns).toEqual(["custom", "patterns"]);
	});
});

describe("malformed values fall back per-part without throwing", () => {
	it("sounds as a non-object (string) yields all defaults", () => {
		writeProjectSettings('{"sounds": "yes"}');
		expect(resolveConfig(projectRoot, agentDir)).toEqual(defaultConfig());
	});

	it("non-array event values are dropped (trigger stays silent)", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": 42}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([]);
	});

	it("non-string entries in a file list are dropped", () => {
		writeProjectSettings('{"sounds": {"events": {"promptSubmit": ["ok.wav", 7, null]}}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.events.promptSubmit).toEqual([join(projectRoot, "ok.wav")]);
	});

	it("invalid turns/elapsed blocks are ignored", () => {
		writeProjectSettings(
			'{"sounds": {"turns": {"every": "many", "files": ["t.wav"]}, "elapsed": {"seconds": -1, "files": ["e.wav"]}}}',
		);
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.turns).toBeUndefined();
		expect(config.elapsed).toBeUndefined();
	});

	it("non-array quotaPatterns keeps the defaults", () => {
		writeProjectSettings('{"sounds": {"quotaPatterns": "nope"}}');
		const config = resolveConfig(projectRoot, agentDir);
		expect(config.quotaPatterns).toEqual(DEFAULT_QUOTA_PATTERNS);
	});

	it("non-boolean enabled is ignored", () => {
		writeProjectSettings('{"sounds": {"enabled": "no"}}');
		expect(resolveConfig(projectRoot, agentDir).enabled).toBe(true);
	});
});

/** Stable home-dir helper for assertions: resolveConfig expands ~ against the real home. */
function homedirSafe(): string {
	return homedir();
}
