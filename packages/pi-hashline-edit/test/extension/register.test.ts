import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register from "../../index";
import {
	__resetConfigForTests,
	__setGrepEnabledForTests,
} from "../../src/config";

function makeRecordingPI(): { pi: ExtensionAPI; toolNames: string[]; eventNames: string[] } {
	const toolNames: string[] = [];
	const eventNames: string[] = [];
	const pi = {
		registerTool(tool: { name: string }) {
			toolNames.push(tool.name);
		},
		on(name: string) {
			eventNames.push(name);
		},
	} as unknown as ExtensionAPI;
	return { pi, toolNames, eventNames };
}

describe("extension registration", () => {
	// Isolate from the developer's real ~/.pi/agent/hashline.json (loaded at
	// module init): tests assert against config defaults, not machine state.
	beforeEach(() => {
		__resetConfigForTests();
	});

	afterEach(() => {
		__resetConfigForTests();
	});

	it("registers the read and edit tools; grep when rg is available", () => {
		// Records registrations instead of using the shared fixture registry; the
		// cast names the gap: only registerTool/on are implemented.
		const { pi, toolNames, eventNames } = makeRecordingPI();

		register(pi);

		// grep is only registered when getGrepEnabled() returns true (config default: false).
		// rg availability remains a secondary gate but config is the primary one.
		const expectedTools = ["edit", "read"];
		expect(toolNames.sort()).toEqual(expectedTools);
		// session_start is always registered to emit config warnings when present.
		expect(eventNames).toEqual(["session_start"]);
	});

	it("includes grep when grep is enabled in config and rg is available", () => {
		__setGrepEnabledForTests(true);

		const rgAvailable =
			spawnSync("rg", ["--version"]).error === undefined &&
			spawnSync("rg", ["--version"]).status === 0;

		const { pi, toolNames } = makeRecordingPI();
		register(pi);

		if (rgAvailable) {
			expect(toolNames.sort()).toContain("grep");
		} else {
			expect(toolNames.sort()).not.toContain("grep");
		}
	});
});

describe("extension registration — compat registry publish", () => {
	// Pi loads every extension in an isolated jiti instance (moduleCache:
	// false), so consumers cannot import this module and see our store. The
	// registry on globalThis is the one shared channel.
	const REGISTRY_KEY = "__piHashlineEditCompat";
	type RegistryHost = typeof globalThis & Record<string, unknown>;

	afterEach(() => {
		delete (globalThis as RegistryHost)[REGISTRY_KEY];
	});

	it("publishes the live compat contract on globalThis at load", () => {
		__resetConfigForTests();
		const { pi } = makeRecordingPI();
		register(pi);

		const entry = (globalThis as RegistryHost)[REGISTRY_KEY] as
			| {
					COMPAT_VERSION: number;
					isHashlineEditActive(): boolean;
					readNormalizedForAnnotate(path: string): unknown;
					commitExternalRead(path: string, normalized: string): unknown;
					mintAnchor(fileLines: string[], line1: number): string;
			  }
			| undefined;
		expect(entry).toBeDefined();
		expect(entry?.COMPAT_VERSION).toBe(1);
		// The factory flipped the flag before publishing, and the entry
		// reports it live (re-read per call, not snapshotted).
		expect(entry?.isHashlineEditActive()).toBe(true);
		expect(typeof entry?.readNormalizedForAnnotate).toBe("function");
		expect(typeof entry?.commitExternalRead).toBe("function");
		expect(typeof entry?.mintAnchor).toBe("function");
	});
});
