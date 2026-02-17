import { describe, expect, it } from "vitest";
import { parseCommitCommandArgs } from "../src/args.js";
import { computeDependencyOrder, validateSplitPlan } from "../src/split.js";
import { formatCommitMessage, generateFallbackProposal, validateProposal } from "../src/validation.js";

describe("commit args", () => {
	it("parses quoted context, model, and split flags", () => {
		const parsed = parseCommitCommandArgs(
			'--dry-run --split --allow-mixed-index --max-split-commits 5 --context "touches API" -m anthropic/claude-sonnet',
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.dryRun).toBe(true);
		expect(parsed.value.split).toBe(true);
		expect(parsed.value.allowMixedIndex).toBe(true);
		expect(parsed.value.maxSplitCommits).toBe(5);
		expect(parsed.value.context).toBe("touches API");
		expect(parsed.value.model).toBe("anthropic/claude-sonnet");
	});

	it("rejects conflicting split flags", () => {
		const parsed = parseCommitCommandArgs("--split --no-split");
		expect(parsed.ok).toBe(false);
	});

	it("rejects unknown flags", () => {
		const parsed = parseCommitCommandArgs("--wat");
		expect(parsed.ok).toBe(false);
	});
});

describe("commit validation", () => {
	it("normalizes and validates proposal", () => {
		const result = validateProposal({
			type: "fix",
			scope: "api",
			summary: "fixed request timeout handling",
			details: ["Added retry guard"],
			issueRefs: ["123"],
			warnings: [],
		});

		expect(result.valid).toBe(true);
		expect(result.proposal.details[0]).toBe("Added retry guard.");
		expect(result.proposal.issueRefs[0]).toBe("#123");
	});

	it("generates fallback proposal and commit message", () => {
		const fallback = generateFallbackProposal([
			{ path: "src/parser.ts", additions: 10, deletions: 4 },
			{ path: "src/tokenizer.ts", additions: 2, deletions: 1 },
		]);
		const message = formatCommitMessage(fallback);
		expect(message.subject).toContain(":");
		expect(fallback.summary.length).toBeGreaterThan(0);
	});
});

describe("split plan", () => {
	it("computes dependency order", () => {
		const ordered = computeDependencyOrder([{ dependencies: [] }, { dependencies: [0] }, { dependencies: [1] }]);
		expect(ordered.ok).toBe(true);
		if (!ordered.ok) return;
		expect(ordered.order).toEqual([0, 1, 2]);
	});

	it("validates split plan coverage", () => {
		const validation = validateSplitPlan(
			{
				commits: [
					{
						proposal: {
							type: "fix",
							scope: "api",
							summary: "fixed timeout guard",
							details: ["Added timeout fallback."],
							issueRefs: [],
							warnings: [],
						},
						changes: [{ path: "src/api.ts", hunks: { type: "all" } }],
						dependencies: [],
					},
					{
						proposal: {
							type: "test",
							scope: "api",
							summary: "updated timeout tests",
							details: ["Updated integration coverage."],
							issueRefs: [],
							warnings: [],
						},
						changes: [{ path: "tests/api.test.ts", hunks: { type: "all" } }],
						dependencies: [0],
					},
				],
				warnings: [],
			},
			["src/api.ts", "tests/api.test.ts"],
		);

		expect(validation.valid).toBe(true);
		expect(validation.order).toEqual([0, 1]);
	});
});
