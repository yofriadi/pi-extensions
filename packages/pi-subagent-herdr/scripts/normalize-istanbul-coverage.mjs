import { readFile, writeFile } from "node:fs/promises";

const coveragePath = new URL("../coverage/coverage-final.json", import.meta.url);
const coverage = JSON.parse(await readFile(coveragePath, "utf8"));

for (const fileCoverage of Object.values(coverage)) {
	for (const mapName of ["statementMap", "fnMap", "branchMap"]) {
		for (const entry of Object.values(fileCoverage[mapName] ?? {})) {
			normalizeLocation(entry.loc);
			for (const location of entry.locations ?? []) normalizeLocation(location);
		}
	}
}

await writeFile(coveragePath, `${JSON.stringify(coverage)}\n`);

function normalizeLocation(location) {
	normalizePosition(location?.start);
	normalizePosition(location?.end);
}

function normalizePosition(position) {
	if (position && position.column < 0) position.column = 0;
}
