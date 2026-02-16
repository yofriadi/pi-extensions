import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

type DependencyField = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

const DEPENDENCY_FIELDS: DependencyField[] = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const ROOT = resolve(import.meta.dir, "..");
const ROOT_PACKAGE_JSON = resolve(ROOT, "package.json");
const PACKAGES_DIR = resolve(ROOT, "packages");

const TARGET_PREFIX = "@mariozechner/pi-";
const DISALLOWED_RANGES = new Set(["*", "latest", "", "workspace:*"]);

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

interface AuditIssue {
	filePath: string;
	field: DependencyField;
	dependency: string;
	range: string;
	message: string;
}

function readPackageJson(filePath: string): PackageJson {
	return JSON.parse(readFileSync(filePath, "utf8")) as PackageJson;
}

function gatherPackageJsonFiles(): string[] {
	const files = [ROOT_PACKAGE_JSON];
	if (!existsSync(PACKAGES_DIR)) {
		return files;
	}

	for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packageJsonPath = resolve(PACKAGES_DIR, entry.name, "package.json");
		if (existsSync(packageJsonPath)) {
			files.push(packageJsonPath);
		}
	}

	return files;
}

function isDisallowedRange(range: string): boolean {
	const normalized = range.trim();
	if (DISALLOWED_RANGES.has(normalized)) {
		return true;
	}
	if (normalized.includes("*")) {
		return true;
	}
	return false;
}

function auditPackageJson(filePath: string): AuditIssue[] {
	const pkg = readPackageJson(filePath);
	const issues: AuditIssue[] = [];

	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = pkg[field];
		if (!dependencies) {
			continue;
		}

		for (const [dependency, range] of Object.entries(dependencies)) {
			if (!dependency.startsWith(TARGET_PREFIX)) {
				continue;
			}
			if (!isDisallowedRange(range)) {
				continue;
			}
			issues.push({
				filePath,
				field,
				dependency,
				range,
				message: "Wildcard or floating range is not allowed for external pi dependencies.",
			});
		}
	}

	return issues;
}

function main(): void {
	const packageJsonFiles = gatherPackageJsonFiles();
	const issues = packageJsonFiles.flatMap((filePath) => auditPackageJson(filePath));

	if (issues.length === 0) {
		console.log("Dependency audit passed.");
		return;
	}

	console.error("Dependency audit failed:");
	for (const issue of issues) {
		const relativePath = issue.filePath.replace(`${ROOT}/`, "");
		console.error(
			`- ${relativePath} :: ${issue.field}.${issue.dependency}=${issue.range} -> ${issue.message}`,
		);
	}
	process.exitCode = 1;
}

main();
