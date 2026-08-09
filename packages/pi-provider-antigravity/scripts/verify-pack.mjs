import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const staging = await mkdtemp(join(tmpdir(), "pi-provider-antigravity-pack-"));

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

	const packageJson = execFileSync("tar", ["-xOf", packed, "package/package.json"], {
		encoding: "utf8",
	});
	const parsed = JSON.parse(packageJson);
	const dependency = parsed.dependencies?.["@narumitw/pi-accounts"];
	if (typeof dependency !== "string" || dependency.includes("workspace:")) {
		throw new Error(
			`Published dependency @narumitw/pi-accounts must be a concrete version, got ${JSON.stringify(dependency)}`,
		);
	}
	if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(dependency) && !/^[~^]?\d+\.\d+\.\d+/.test(dependency)) {
		throw new Error(
			`Published dependency @narumitw/pi-accounts must resolve outside the monorepo, got ${JSON.stringify(dependency)}`,
		);
	}

	const accountsExport = parsed.exports?.["./accounts"];
	if (accountsExport !== "./src/accounts-with-antigravity.ts") {
		throw new Error(
			`exports["./accounts"] must point at the composition host, got ${JSON.stringify(accountsExport)}`,
		);
	}

	const extensions = parsed.pi?.extensions;
	if (
		!Array.isArray(extensions) ||
		!extensions.includes("./src/index.ts") ||
		!extensions.includes("./src/accounts-with-antigravity.ts")
	) {
		throw new Error(
			`pi.extensions must include ./src/index.ts and ./src/accounts-with-antigravity.ts, got ${JSON.stringify(extensions)}`,
		);
	}

	const tarballListing = execFileSync("tar", ["-tf", packed], { encoding: "utf8" });
	const requiredPaths = [
		"package/src/account-adapter.ts",
		"package/src/accounts-with-antigravity.ts",
		"package/src/index.ts",
	];
	for (const required of requiredPaths) {
		if (!tarballListing.split("\n").includes(required)) {
			throw new Error(`Packed tarball is missing ${required}`);
		}
	}

	console.log(`verify-pack: @narumitw/pi-accounts -> ${dependency}`);
	console.log(`verify-pack: exports["./accounts"] -> ${accountsExport}`);
	console.log(`verify-pack: pi.extensions -> ${extensions.join(", ")}`);
	console.log(`verify-pack: tarball contains account adapter + composition host`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
