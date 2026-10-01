/**
 * Manifest guards for the host-provided `typebox` package.
 *
 * pi's loader serves `typebox` itself (jiti alias in built mode, virtual module
 * in compiled and TS-source modes) and warns when an extension package declares
 * it under `dependencies`, so the declaration shape is locked here. The
 * devDependency pin exists so `tsc` and the loader-path tests see the same
 * typebox the running host serves: it must track the host's own dependency
 * exactly, otherwise the suite quietly typechecks against a version production
 * never runs (typebox 1.3.x shipped a breaking export rename inside the line).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type DependencyManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

function readManifest(relativePath: string): DependencyManifest {
	return JSON.parse(readFileSync(join(packageRoot, relativePath), "utf-8")) as DependencyManifest;
}

const ownManifest = readManifest("package.json");
// pi-coding-agent does not export ./package.json, but a direct filesystem read
// through the pnpm symlink is not subject to the exports map.
const hostManifest = readManifest(join("node_modules", "@earendil-works", "pi-coding-agent", "package.json"));

describe("pi-tilth — host-provided typebox declaration", () => {
	it('declares typebox as a "*" peer and never as a runtime dependency', () => {
		expect(ownManifest.peerDependencies?.typebox).toBe("*");
		expect(ownManifest.dependencies?.typebox).toBeUndefined();
	});

	it("pins the typebox devDependency to the copy the resolved host bundles", () => {
		const hostTypebox = hostManifest.dependencies?.typebox;
		expect(hostTypebox).toBeDefined();
		const message = `host @earendil-works/pi-coding-agent bundles typebox ${hostTypebox}; update the devDependency pin to match`;
		expect(ownManifest.devDependencies?.typebox, message).toBe(hostTypebox);
	});
});
