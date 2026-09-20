import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const staging = await mkdtemp(join(tmpdir(), "pi-provider-perchai-pack-"));

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

	const entry = parsed.exports?.["."];
	if (entry !== "./src/index.ts") {
		throw new Error(`exports["."] must point at ./src/index.ts, got ${JSON.stringify(entry)}`);
	}

	const extensions = parsed.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== "./src/index.ts") {
		throw new Error(`pi.extensions must be ["./src/index.ts"], got ${JSON.stringify(extensions)}`);
	}

	const tarballListing = execFileSync("tar", ["-tf", packed], { encoding: "utf8" });
	const requiredPaths = [
		"package/src/index.ts",
		"package/src/models.ts",
		"package/src/models.generated.ts",
		"package/src/cli-version.ts",
		"package/src/model-call.ts",
		"package/src/perch-stream.ts",
		"package/src/messages.ts",
		"package/src/errors.ts",
		"package/src/auth/perch-oauth.ts",
		"package/src/auth/cli-session.ts",
		"package/src/vendor/pkce.ts",
		"package/src/vendor/loopback.ts",
	];
	for (const required of requiredPaths) {
		if (!tarballListing.split("\n").includes(required)) {
			throw new Error(`Packed tarball is missing ${required}`);
		}
	}

	console.log(`verify-pack: exports["."] -> ${entry}`);
	console.log(`verify-pack: pi.extensions -> ${extensions.join(", ")}`);
	console.log(`verify-pack: tarball contains all provider source files`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
