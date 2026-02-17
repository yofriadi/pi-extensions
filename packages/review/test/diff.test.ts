import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff.js";
import { buildReviewPrompt } from "../src/prompt.js";

describe("review diff parser", () => {
	it("parses files and counts + / - lines", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,3 @@",
			" line 1",
			"-old",
			"+new",
			"+extra",
		].join("\n");

		const stats = parseDiff(diff);
		expect(stats.files).toHaveLength(1);
		expect(stats.files[0]?.path).toBe("src/a.ts");
		expect(stats.totalAdded).toBe(2);
		expect(stats.totalRemoved).toBe(1);
	});

	it("excludes lock files from reviewable stats", () => {
		const diff = [
			"diff --git a/bun.lock b/bun.lock",
			"index 111..222 100644",
			"--- a/bun.lock",
			"+++ b/bun.lock",
			"@@ -1 +1 @@",
			"-a",
			"+b",
		].join("\n");

		const stats = parseDiff(diff);
		expect(stats.files).toHaveLength(0);
		expect(stats.excluded).toHaveLength(1);
		expect(stats.excluded[0]?.reason).toBe("lock file");
	});

	it("stores compact per-file preview instead of full hunk", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"index 111..222 100644",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");

		const stats = parseDiff(diff);
		expect(stats.files[0]?.preview).toBe("-old\n+new");
	});

	it("builds a prompt with workflow instructions", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		const stats = parseDiff(diff);

		const prompt = buildReviewPrompt({
			mode: "Reviewing commit `abc123`",
			stats,
			rawDiff: diff,
			executionMode: "direct",
		});

		expect(prompt).toContain("Interactive Code Review Request");
		expect(prompt).toContain("report_finding");
		expect(prompt).toContain("submit_review");
		expect(prompt).toContain("```diff");
	});

	it("uses task-oriented guidance when task mode is enabled", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		const stats = parseDiff(diff);

		const prompt = buildReviewPrompt({
			mode: "Reviewing uncommitted changes",
			stats,
			rawDiff: diff,
			executionMode: "task",
		});

		expect(prompt).toContain("Use Task tool");
	});
});
