/**
 * Registry-first resolution for the hashline compat bridge.
 *
 * Pi loads every extension in an isolated jiti instance (moduleCache: false),
 * so the bridge must prefer the process-global registry that
 * pi-hashline-edit's index.ts publishes at extension load — its functions
 * close over the snapshot store the edit tool reads. The dynamic-import
 * fallback stays for same-module-tree runtimes (unit tests).
 */

import { setHashlineEditActive } from "pi-hashline-edit/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCompatActive, resetCompatModule, resolveCompatModule } from "../../src/lib/hashline-bridge";

const REGISTRY_KEY = "__piHashlineEditCompat";

/** The registry entry a loaded pi-hashline-edit extension publishes. */
type RegistryHost = typeof globalThis & Record<string, unknown>;

function registryHost(): RegistryHost {
	return globalThis as RegistryHost;
}

function fakeCompat(overrides: Record<string, unknown> = {}) {
	return {
		COMPAT_VERSION: 1,
		isHashlineEditActive: () => true,
		readNormalizedForAnnotate: (_path: string) => Promise.resolve(null),
		commitExternalRead: (_path: string, _normalized: string) => Promise.resolve(),
		mintAnchor: (lines: string[], line1: number) => `${lines.length}#${line1}`,
		...overrides,
	};
}

describe("hashline-bridge — registry resolution", () => {
	beforeEach(() => {
		resetCompatModule();
	});

	afterEach(() => {
		delete registryHost()[REGISTRY_KEY];
		setHashlineEditActive(false);
	});

	it("resolves the registry entry the loaded extension published", async () => {
		const published = fakeCompat();
		registryHost()[REGISTRY_KEY] = published;

		const mod = await resolveCompatModule();
		expect(mod).toBe(published);
	});

	it("prefers the registry over a same-tree import (store identity)", async () => {
		// The imported module copy is inactive in the test process — only the
		// registry entry reports a live extension. If the bridge imported
		// instead, isCompatActive would be false.
		const published = fakeCompat();
		registryHost()[REGISTRY_KEY] = published;
		setHashlineEditActive(false);

		const mod = await resolveCompatModule();
		expect(mod).toBe(published);
		expect(isCompatActive(mod, true)).toBe(true);
	});

	it("rejects a registry entry that does not match the compat shape", async () => {
		registryHost()[REGISTRY_KEY] = { COMPAT_VERSION: 1, isHashlineEditActive: "yes" };
		const mod = await resolveCompatModule();
		// Falls back to the import path: shape-gated, not shape-trusted.
		expect(mod).not.toBeNull();
		expect(mod?.COMPAT_VERSION).toBe(1);
	});

	it("falls back to the dynamic import when no entry is published", async () => {
		const mod = await resolveCompatModule();
		expect(mod).not.toBeNull();
		expect(mod?.COMPAT_VERSION).toBe(1);
	});

	it("activation still honors the version gate on registry entries", async () => {
		registryHost()[REGISTRY_KEY] = fakeCompat({ COMPAT_VERSION: 2 });
		const mod = await resolveCompatModule();
		expect(mod).not.toBeNull();
		expect(isCompatActive(mod, true)).toBe(false);
	});

	it("activation still honors the activity flag and config switch", async () => {
		let active = false;
		registryHost()[REGISTRY_KEY] = fakeCompat({ isHashlineEditActive: () => active });

		const mod = await resolveCompatModule();
		expect(mod).not.toBeNull();
		expect(isCompatActive(mod, true)).toBe(false);
		active = true;
		expect(isCompatActive(mod, true)).toBe(true);
		expect(isCompatActive(mod, false)).toBe(false);
	});
});
