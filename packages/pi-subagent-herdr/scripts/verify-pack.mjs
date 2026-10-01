import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_ENGINE_NODE = ">=22.19.0";
const REQUIRED_PATHS = [
	"package/src/index.ts",
	"package/README.md",
	"package/CHANGELOG.md",
	"package/LICENSE",
	"package/package.json",
];
const FORBIDDEN_PREFIXES = ["package/test/", "package/coverage/", "package/node_modules/"];
const FORBIDDEN_PATHS = ["package/tsconfig.json", "package/vitest.config.ts"];
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const failures = [];
function check(ok, message) {
	if (!ok) failures.push(message);
}

const staging = await mkdtemp(join(tmpdir(), "pi-subagent-herdr-pack-"));
try {
	const packed = execFileSync("pnpm", ["pack", "--pack-destination", staging], {
		cwd: packageDir,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter(Boolean)
		.at(-1);
	if (!packed) throw new Error("pnpm pack did not produce a tarball path");

	const manifest = JSON.parse(
		execFileSync("tar", ["-xOf", packed, "package/package.json"], { encoding: "utf8" }),
	);
	const workspace = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

	check(
		typeof manifest.name === "string" && manifest.name === workspace.name,
		`packed name must be ${JSON.stringify(workspace.name)}, got ${JSON.stringify(manifest.name)}`,
	);
	check(manifest.type === "module", `packed "type" must be "module", got ${JSON.stringify(manifest.type)}`);
	check(
		manifest.engines?.node === EXPECTED_ENGINE_NODE,
		`packed engines.node must be ${JSON.stringify(EXPECTED_ENGINE_NODE)}, got ${JSON.stringify(manifest.engines?.node)}`,
	);
	check(
		manifest.exports?.["."] === "./src/index.ts",
		`exports["."] must resolve "./src/index.ts", got ${JSON.stringify(manifest.exports?.["."])}`,
	);
	check(
		manifest.exports?.["./package.json"] === "./package.json",
		`exports["./package.json"] must resolve "./package.json", got ${JSON.stringify(manifest.exports?.["./package.json"])}`,
	);
	const extensions = manifest.pi?.extensions;
	check(
		Array.isArray(extensions) && extensions.includes("./src/index.ts"),
		`pi.extensions must include "./src/index.ts", got ${JSON.stringify(extensions)}`,
	);

	for (const section of DEPENDENCY_SECTIONS) {
		for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
			check(
				typeof specifier === "string" && !specifier.startsWith("workspace:"),
				`${section}["${name}"] has an unresolved workspace specifier: ${JSON.stringify(specifier)}`,
			);
		}
	}

	const listing = execFileSync("tar", ["-tf", packed], { encoding: "utf8" })
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "" && !entry.endsWith("/"));
	const entries = new Set(listing);

	for (const required of REQUIRED_PATHS) {
		check(entries.has(required), `packed tarball is missing ${required}`);
	}
	for (const forbidden of FORBIDDEN_PATHS) {
		check(!entries.has(forbidden), `packed tarball must not contain ${forbidden}`);
	}
	for (const prefix of FORBIDDEN_PREFIXES) {
		const leaked = listing.filter((entry) => entry.startsWith(prefix));
		check(leaked.length === 0, `packed tarball must not contain ${prefix} entries: ${leaked.join(", ")}`);
	}

	// Fail closed: every published file must sit inside the packed manifest's
	// own `files` allowlist, so new development files cannot slip in unnoticed.
	// NOTE: this assumes `files` explicitly lists the npm-implicit artifacts
	// (README, LICENSE, CHANGELOG, package.json), which it currently does. npm
	// always packs those regardless of `files`; if `files` is ever trimmed to
	// rely on that implicit inclusion, widen the allowlist here too or these
	// files will be flagged as outside the allowlist even though they belong.
	const allowlist = (Array.isArray(manifest.files) ? manifest.files : []).map((pattern) =>
		pattern.replace(/\/+$/, ""),
	);
	function isAllowlisted(tarballPath) {
		const relative = tarballPath.replace(/^package\//, "");
		return allowlist.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`));
	}
	const unexpected = listing.filter((entry) => !isAllowlisted(entry));
	check(
		allowlist.length > 0 && unexpected.length === 0,
		`packed tarball contains files outside the published allowlist (${JSON.stringify(allowlist)}): ${unexpected.join(", ")}`,
	);

	if (failures.length > 0) {
		console.error(`verify-pack: ${failures.length} contract violation(s) in ${packed}:`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exitCode = 1;
	} else {
		console.log(`verify-pack: ${manifest.name}@${manifest.version} satisfies the package contract`);
		console.log(`verify-pack: exports["."] -> ${manifest.exports["."]}`);
		console.log(`verify-pack: pi.extensions -> ${extensions.join(", ")}`);
		console.log(`verify-pack: tarball contains ${listing.length} files, all within the published allowlist`);
	}
} finally {
	await rm(staging, { recursive: true, force: true });
}
