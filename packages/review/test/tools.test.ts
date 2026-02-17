import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFindingPath } from "../src/tools.js";

describe("review tool path sanitization", () => {
	const cwd = "/repo";

	it("keeps workspace-relative paths", () => {
		expect(sanitizeFindingPath(cwd, "src/index.ts")).toBe("src/index.ts");
	});

	it("converts absolute in-workspace paths to relative", () => {
		expect(sanitizeFindingPath(cwd, "/repo/src/index.ts")).toBe("src/index.ts");
	});

	it("rejects parent traversal escaping workspace", () => {
		expect(sanitizeFindingPath(cwd, "../secret.txt")).toBeUndefined();
	});

	it("rejects absolute path outside workspace", () => {
		const outside = path.resolve(cwd, "../secret.txt");
		expect(sanitizeFindingPath(cwd, outside)).toBeUndefined();
	});
});
