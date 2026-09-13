/**
 * Loader-level interop: pi-hashline-edit and pi-tilth loaded as two real
 * extension packages through discoverAndLoadExtensions (no loader mocking).
 *
 * This is the deployment topology pi actually runs: each extension is loaded
 * in an isolated jiti instance (moduleCache: false), so the compat contract
 * can only cross the extension boundary through the process-global registry
 * pi-hashline-edit's index.ts publishes at load. The test proves:
 *  - the real hashline extension publishes a live registry entry, and
 *  - pi-tilth's bridge (a module instance separate from the loaded
 *    extension's) resolves that entry and reports compat active, with
 *    functioning store closures that hash identically to the source code.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Pure function, no module state: a separate import computes identical
// hashes, so this is a valid oracle for the published entry's mintAnchor.
import { computeLineHash } from "../../pi-hashline-edit/src/hashline";
import { isCompatActive, resetCompatModule, resolveCompatModule } from "../src/lib/hashline-bridge";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, "..");
const hashlineRoot = join(packageRoot, "..", "pi-hashline-edit");

const REGISTRY_KEY = "__piHashlineEditCompat";
type RegistryHost = typeof globalThis & Record<string, unknown>;

describe("hashline-bridge — registry interop through the real loader", () => {
	let agentDir: string;
	let workDir: string;

	beforeEach(async () => {
		agentDir = join(packageRoot, "test", ".tmp-agent-interop");
		workDir = await mkdtemp(join(tmpdir(), "pi-tilth-interop-loader-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
		await rm(workDir, { recursive: true, force: true });
		delete (globalThis as RegistryHost)[REGISTRY_KEY];
		resetCompatModule();
	});

	it("the loaded hashline extension publishes a registry entry the bridge activates on", async () => {
		const result = await discoverAndLoadExtensions(
			[hashlineRoot, packageRoot],
			workDir,
			agentDir,
			createEventBus(),
		);

		expect(result.errors).toEqual([]);
		// Both packages registered their tools through the real loader.
		const toolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
		expect(toolNames).toEqual(expect.arrayContaining(["read", "edit", "tilth_read", "tilth_search", "tilth_list"]));

		// The registry entry exists and reports a live extension.
		const registered = (globalThis as RegistryHost)[REGISTRY_KEY] as
			| {
					COMPAT_VERSION: number;
					isHashlineEditActive(): boolean;
					readNormalizedForAnnotate(path: string): Promise<{ normalized: string; lines: string[] } | null>;
					mintAnchor(fileLines: string[], line1: number): string;
			  }
			| undefined;
		expect(registered).toBeDefined();
		expect(registered?.COMPAT_VERSION).toBe(1);
		expect(registered?.isHashlineEditActive()).toBe(true);

		// The bridge — a module instance separate from the loaded extensions —
		// resolves that entry (not a fresh import, whose flag is false here)
		// and compat activates.
		const mod = await resolveCompatModule();
		expect(mod).toBe(registered);
		expect(isCompatActive(mod, true)).toBe(true);

		// The registry entry's closures work against a real file: it reads
		// and hashes exactly like the source-level oracle.
		const file = join(workDir, "anchor.ts");
		const lines = ["export function alpha(): number {", "\treturn 1;}", "}"];
		await writeFile(file, lines.join("\n"));
		const normalized = await registered?.readNormalizedForAnnotate(file);
		expect(normalized).not.toBeNull();
		expect(normalized?.lines).toEqual(lines);
		expect(registered?.mintAnchor(lines, 2)).toBe(computeLineHash(lines, 1));
	});
});
