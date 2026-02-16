import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const PACKAGE_NAMES = ["ast", "lsp", "mcp", "web-search", "fuzzy-match", "hashline-edit"] as const;
type PackageName = (typeof PACKAGE_NAMES)[number];

type HardeningCheck = {
	path: string;
	includes: string[];
};

type PackageScore = {
	packageName: PackageName;
	tests: {
		count: number;
		score: number;
	};
	docs: {
		readme: boolean;
		score: number;
	};
	hardening: {
		passed: boolean;
		score: number;
		missing: string[];
	};
	total: number;
};

type ScorecardReport = {
	generatedAt: string;
	scoreVersion: 1;
	packages: Record<PackageName, PackageScore>;
};

type BaselineFile = {
	minimums: Record<PackageName, { tests: number; docs: number; hardening: number; total: number }>;
};

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = resolve(ROOT, "scorecard", "baseline.json");

const HARDENING_CHECKS: Record<PackageName, HardeningCheck[]> = {
	ast: [
		{
			path: "packages/ast/src/tools/ast-search.ts",
			includes: ["sg", "--json"],
		},
		{
			path: "packages/ast/src/utils/exec.ts",
			includes: ["existingPath", "node_modules", ".bin"],
		},
	],
	lsp: [
		{
			path: "packages/lsp/src/client/runtime.ts",
			includes: ["MAX_OUTPUT_BUFFER_BYTES", "MAX_FRAME_CONTENT_LENGTH", "normalizeRequestId"],
		},
		{
			path: "packages/lsp/src/config/resolver.ts",
			includes: ["splitCommandString", "quote", "escaped"],
		},
	],
	mcp: [
		{
			path: "packages/mcp/src/runtime/mcp-runtime.ts",
			includes: ["Content-Length", "state: \"starting\"", "normalizeJsonRpcId"],
		},
		{
			path: "packages/mcp/src/tools/mcp-tool-bridge.ts",
			includes: ["safeJsonStringify", "MAX_JSON_RESULT_CHARS"],
		},
	],
	"web-search": [
		{
			path: "packages/web-search/src/fetch/tool.ts",
			includes: ["isPrivateOrLocalHost", "fetchWithTimeout", "bindAbortSignal"],
		},
	],
	"fuzzy-match": [
		{
			path: "packages/fuzzy-match/src/index.ts",
			includes: ["findBestFuzzyMatchCore", "countOccurrencesWithSample", "dominantFuzzy"],
		},
	],
	"hashline-edit": [
		{
			path: "packages/hashline-edit/src/index.ts",
			includes: ["HASH_LEN = 8", "HashlineMismatchError", "parseLineRef"],
		},
	],
};

function collectReport(): ScorecardReport {
	const packageScores = Object.fromEntries(PACKAGE_NAMES.map((packageName) => [packageName, collectPackageScore(packageName)])) as Record<
		PackageName,
		PackageScore
	>;

	return {
		generatedAt: new Date().toISOString(),
		scoreVersion: 1,
		packages: packageScores,
	};
}

function collectPackageScore(packageName: PackageName): PackageScore {
	const packageDir = resolve(ROOT, "packages", packageName);
	const testDir = resolve(packageDir, "test");
	const readmePath = resolve(packageDir, "README.md");

	const testCount = countTestFiles(testDir);
	const docsPresent = existsSync(readmePath);
	const hardening = evaluateHardening(packageName);

	const testsScore = testCount > 0 ? 1 : 0;
	const docsScore = docsPresent ? 1 : 0;
	const hardeningScore = hardening.passed ? 1 : 0;

	return {
		packageName,
		tests: {
			count: testCount,
			score: testsScore,
		},
		docs: {
			readme: docsPresent,
			score: docsScore,
		},
		hardening: {
			passed: hardening.passed,
			score: hardeningScore,
			missing: hardening.missing,
		},
		total: testsScore + docsScore + hardeningScore,
	};
}

function countTestFiles(testDir: string): number {
	if (!existsSync(testDir)) {
		return 0;
	}
	let count = 0;
	for (const filePath of walkFiles(testDir)) {
		if (filePath.endsWith(".test.ts")) {
			count += 1;
		}
	}
	return count;
}

function walkFiles(dir: string): string[] {
	const output: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			output.push(...walkFiles(fullPath));
			continue;
		}
		if (entry.isFile()) {
			output.push(fullPath);
		}
	}
	return output;
}

function evaluateHardening(packageName: PackageName): { passed: boolean; missing: string[] } {
	const checks = HARDENING_CHECKS[packageName];
	const missing: string[] = [];

	for (const check of checks) {
		const fullPath = resolve(ROOT, check.path);
		if (!existsSync(fullPath)) {
			missing.push(`${check.path} (missing file)`);
			continue;
		}

		const content = readFileSync(fullPath, "utf8");
		for (const needle of check.includes) {
			if (!content.includes(needle)) {
				missing.push(`${check.path} :: ${needle}`);
			}
		}
	}

	return {
		passed: missing.length === 0,
		missing,
	};
}

function loadBaseline(path: string): BaselineFile {
	if (!existsSync(path)) {
		throw new Error(`Baseline file not found: ${relative(ROOT, path)}`);
	}
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BaselineFile>;
	if (!raw || typeof raw !== "object" || !raw.minimums) {
		throw new Error(`Invalid baseline format: ${relative(ROOT, path)}`);
	}
	return raw as BaselineFile;
}

function checkAgainstBaseline(report: ScorecardReport, baseline: BaselineFile): string[] {
	const regressions: string[] = [];

	for (const packageName of PACKAGE_NAMES) {
		const current = report.packages[packageName];
		const minimum = baseline.minimums[packageName];
		if (!minimum) {
			regressions.push(`[${packageName}] baseline minimums missing`);
			continue;
		}

		if (current.tests.score < minimum.tests) {
			regressions.push(`[${packageName}] tests score regressed: ${current.tests.score} < ${minimum.tests}`);
		}
		if (current.docs.score < minimum.docs) {
			regressions.push(`[${packageName}] docs score regressed: ${current.docs.score} < ${minimum.docs}`);
		}
		if (current.hardening.score < minimum.hardening) {
			regressions.push(`[${packageName}] hardening score regressed: ${current.hardening.score} < ${minimum.hardening}`);
		}
		if (current.total < minimum.total) {
			regressions.push(`[${packageName}] total score regressed: ${current.total} < ${minimum.total}`);
		}
	}

	return regressions;
}

function writeBaseline(report: ScorecardReport, path: string): void {
	const minimums = Object.fromEntries(
		PACKAGE_NAMES.map((packageName) => {
			const score = report.packages[packageName];
			return [
				packageName,
				{
					tests: score.tests.score,
					docs: score.docs.score,
					hardening: score.hardening.score,
					total: score.total,
				},
			];
		}),
	) as BaselineFile["minimums"];

	writeFileSync(path, `${JSON.stringify({ minimums }, null, 2)}\n`, "utf8");
}

function printUsage(): void {
	console.log("Usage: bun scripts/scorecard.ts <report|check|baseline>");
}

function main(): void {
	const mode = process.argv[2] ?? "report";
	const report = collectReport();

	if (mode === "report") {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	if (mode === "baseline") {
		writeBaseline(report, BASELINE_PATH);
		console.log(`Wrote baseline: ${relative(ROOT, BASELINE_PATH)}`);
		return;
	}

	if (mode === "check") {
		const baseline = loadBaseline(BASELINE_PATH);
		const regressions = checkAgainstBaseline(report, baseline);
		if (regressions.length > 0) {
			console.error("Scorecard regression(s) detected:");
			for (const regression of regressions) {
				console.error(`- ${regression}`);
			}
			process.exitCode = 1;
			return;
		}
		console.log("Scorecard check passed.");
		return;
	}

	printUsage();
	process.exitCode = 1;
}

main();
