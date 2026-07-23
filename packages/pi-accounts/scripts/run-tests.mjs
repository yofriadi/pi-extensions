#!/usr/bin/env node
// Compiles this package's src/ and test/ TypeScript to CommonJS-free ESM
// JavaScript, then runs the compiled tests with Node's built-in test runner.
// Kept close to upstream's own scripts/run-tests.mjs so the subtree stays
// easy to diff against github.com/narumiruna/pi-extensions.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(packageRoot, ".test-out");
const tsc = path.join(
	packageRoot,
	"..",
	"..",
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

fs.rmSync(outDir, { recursive: true, force: true });

run(tsc, ["-p", "tsconfig.test.json"]);

const testFiles = findFiles(path.join(outDir, "test"), ".test.js");
if (testFiles.length === 0) {
	console.error("No compiled test files found.");
	process.exit(1);
}

run(process.execPath, ["--test", ...testFiles]);

function findFiles(directory, suffix) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix));
		else if (entry.name.endsWith(suffix)) files.push(entryPath);
	}
	return files;
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
