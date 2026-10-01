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
	version?: string;
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

// ---------------------------------------------------------------------------
// @earendil-works/pi-mcp — native MCP transport runtime dependency
// ---------------------------------------------------------------------------

const piMcpManifest = readManifest(join("node_modules", "@earendil-works", "pi-mcp", "package.json"));
const piMcpRange = ownManifest.dependencies?.["@earendil-works/pi-mcp"];

/** Minimal caret-range check: supports the single `^MAJOR.MINOR.PATCH` shape used here. */
function satisfiesCaret(version: string, range: string): boolean {
	const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
	if (!m) throw new Error(`unsupported range: ${range}`);
	const major = Number(m[1]);
	const minor = Number(m[2]);
	const patch = Number(m[3]);
	const [vMajor = 0, vMinor = 0, vPatch = 0] = version.split(".").map(Number);
	if (vMajor !== major) return false;
	if (major === 0) return vMinor === minor && vPatch >= patch; // ^0.x.y
	return vMinor > minor || (vMinor === minor && vPatch >= patch);
}

describe("pi-tilth — native MCP transport dependency declaration", () => {
	it("declares @earendil-works/pi-mcp as a runtime dependency, never a peer", () => {
		expect(piMcpRange).toBe("^0.99.1");
		expect(ownManifest.peerDependencies?.["@earendil-works/pi-mcp"]).toBeUndefined();
	});

	it("resolves a version satisfying the declared ^0.99.1 range", () => {
		expect(piMcpManifest.version, "resolved @earendil-works/pi-mcp version").toBeDefined();
		expect(
			satisfiesCaret(piMcpManifest.version ?? "0.0.0", "^0.99.1"),
			`resolved ${piMcpManifest.version} must satisfy ^0.99.1`,
		).toBe(true);
	});
});
