#!/usr/bin/env node
/**
 * Repo guard: pi's extension loader supplies a fixed set of packages itself —
 * jiti aliases in built mode, virtual modules in compiled and TS-source modes —
 * and warns at startup when an extension package lists one of them under
 * `dependencies`, because an installed copy resolves outside the host's single
 * module instance.
 *
 * Declare them in `peerDependencies` with a `"*"` range instead, plus an exact
 * `devDependency` pinned to the copy the host bundles when tsc or tests need it.
 * The set below mirrors `HOST_PROVIDED_EXTENSION_PACKAGES` in pi's
 * resource-loader; update it when the host's list changes.
 *
 * Wired into `pnpm run check`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOST_PROVIDED = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);
const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

const packagesDir = join(import.meta.dirname, "..", "packages");
const manifests = readdirSync(packagesDir, { recursive: true })
	.filter((entry) => entry.endsWith("package.json") && !entry.includes("node_modules"))
	.map((entry) => join(packagesDir, entry))
	.sort();

const violations = [];
for (const manifestPath of manifests) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	for (const field of RUNTIME_DEPENDENCY_FIELDS) {
		const deps = manifest[field];
		if (deps === undefined || deps === null || typeof deps !== "object" || Array.isArray(deps)) {
			continue;
		}
		const hits = Object.keys(deps)
			.filter((name) => HOST_PROVIDED.has(name))
			.sort();
		if (hits.length > 0) {
			violations.push(`${manifestPath}: ${field} -> ${hits.join(", ")}`);
		}
	}
}

if (violations.length > 0) {
	console.error(
		[
			"Host-provided packages must not be declared as runtime dependencies:",
			...violations.map((violation) => `  ${violation}`),
			`Move each to peerDependencies with a "*" range, and add an exact devDependency`,
			"pinned to the version the pi host bundles when tsc or tests need the types.",
		].join("\n"),
	);
	process.exit(1);
}

console.log(`host-provided deps: ${manifests.length} package manifests clean`);
