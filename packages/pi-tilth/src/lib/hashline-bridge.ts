/**
 * Guarded bridge to `pi-hashline-edit/compat` (design D7).
 *
 * Two resolution paths, tried in order:
 *  1. **Process-global registry** — pi-hashline-edit's index.ts publishes its
 *     compat module on `globalThis[COMPAT_REGISTRY_KEY]` at extension load.
 *     Pi's extension loader creates a fresh jiti instance per extension
 *     (`moduleCache: false`), so *importing* `pi-hashline-edit/compat` from
 *     another extension yields a second module copy with its own snapshot
 *     store and activity flag — commits would land in a store the edit tool
 *     cannot see. The published object is built inside the hashline
 *     extension's own module graph, so its functions close over the store
 *     the edit tool reads; globalThis is the one channel shared across
 *     extension module graphs.
 *  2. **Dynamic import of `pi-hashline-edit/compat`** — the original
 *     same-module-tree path (unit tests, runtimes that share modules, or a
 *     consumer that loaded the compat module through its own graph). The
 *     repo's no-dynamic-imports rule is explicitly waived here: the two
 *     extensions must each work standalone, and every import failure is
 *     "compat off" — silently.
 *
 * The registry key literal is duplicated from pi-hashline-edit's
 * src/compat-registry.ts: pi-tilth must resolve the registry even on machines
 * where the package cannot be imported at all. Compat activates per call
 * only when: a module resolved AND COMPAT_VERSION matches AND
 * isHashlineEditActive() AND config hashlineCompat !== false. The activity
 * flag is re-read per call so extension load order never matters.
 */

export interface CompatModule {
	COMPAT_VERSION: number;
	isHashlineEditActive(): boolean;
	readNormalizedForAnnotate(path: string): Promise<{ normalized: string; lines: string[] } | null>;
	commitExternalRead(path: string, normalized: string): Promise<void>;
	mintAnchor(fileLines: string[], line1: number): string;
}

/** Structural subset the annotator may use — keeps call sites honest. */
export interface HashlineCompat {
	readNormalizedForAnnotate(path: string): Promise<{ normalized: string; lines: string[] } | null>;
	commitExternalRead(path: string, normalized: string): Promise<void>;
	mintAnchor(fileLines: string[], line1: number): string;
}

/** Mirrors COMPAT_REGISTRY_KEY in pi-hashline-edit's src/compat-registry.ts. */
const COMPAT_REGISTRY_KEY = "__piHashlineEditCompat";

const EXPECTED_COMPAT_VERSION = 1;

let settled: CompatModule | null | undefined;

/** Registry access without an index signature on typeof globalThis. */
type RegistryHost = typeof globalThis & Record<string, unknown>;

function isValidCompatShape(value: unknown): value is CompatModule {
	const mod = value as Partial<CompatModule> | null | undefined;
	return (
		typeof mod?.COMPAT_VERSION === "number" &&
		typeof mod.isHashlineEditActive === "function" &&
		typeof mod.readNormalizedForAnnotate === "function" &&
		typeof mod.commitExternalRead === "function" &&
		typeof mod.mintAnchor === "function"
	);
}

/**
 * Resolve (once per session) the compat module or null. Safe to call when
 * pi-hashline-edit is not installed at all: neither path resolves, and the
 * negative result is cached.
 */
export async function resolveCompatModule(): Promise<CompatModule | null> {
	if (settled !== undefined) return settled;

	// Path 1: the process-global registry published by the loaded
	// pi-hashline-edit extension. Preferred because its functions close over
	// the snapshot store the edit tool actually reads.
	const registered = (globalThis as RegistryHost)[COMPAT_REGISTRY_KEY];
	if (isValidCompatShape(registered)) {
		settled = registered;
		return settled;
	}

	// Path 2: dynamic import (same-module-tree runtimes, tests).
	try {
		const mod = (await import("pi-hashline-edit/compat")) as unknown;
		if (isValidCompatShape(mod)) {
			settled = mod;
		} else {
			settled = null;
		}
	} catch {
		settled = null;
	}
	return settled;
}

/** Test hook: forget the cached resolution. */
export function resetCompatModule(): void {
	settled = undefined;
}

/**
 * Per-call activation check: module resolved AND version match AND the
 * pi-hashline-edit extension is active in the resolved module AND the user
 * has not disabled compat in config.
 */
export function isCompatActive(module: CompatModule | null, configEnabled: boolean): boolean {
	if (!module) return false;
	if (module.COMPAT_VERSION !== EXPECTED_COMPAT_VERSION) return false;
	if (!module.isHashlineEditActive()) return false;
	if (!configEnabled) return false;
	return true;
}
