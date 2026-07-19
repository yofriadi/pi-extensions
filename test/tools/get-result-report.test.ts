import { describe, expect, it } from "vitest";
import {
	type AgentReport,
	formatAgentReport,
	renderReportBody,
	renderStatsParts,
} from "#src/tools/get-result-report";

function makeReport(overrides: Partial<AgentReport> = {}): AgentReport {
	return {
		id: "agent-1",
		displayName: "General",
		status: "completed",
		toolUses: 3,
		tokens: "",
		contextPercent: null,
		compactionCount: 0,
		duration: "12.3s",
		description: "Investigate the bug",
		result: "All done.",
		error: undefined,
		conversation: undefined,
		...overrides,
	};
}

describe("renderStatsParts", () => {
	it("always includes tool uses and duration", () => {
		const parts = renderStatsParts(makeReport());
		expect(parts).toEqual(["Tool uses: 3", "Duration: 12.3s"]);
	});

	it("includes tokens when present", () => {
		const parts = renderStatsParts(makeReport({ tokens: "33.8k token" }));
		expect(parts).toEqual(["Tool uses: 3", "33.8k token", "Duration: 12.3s"]);
	});

	it("omits tokens when empty string", () => {
		const parts = renderStatsParts(makeReport({ tokens: "" }));
		expect(parts).not.toContain("");
	});

	it("includes rounded context percent when present", () => {
		const parts = renderStatsParts(makeReport({ contextPercent: 42.6 }));
		expect(parts).toContain("Context: 43%");
	});

	it("omits context when null", () => {
		const parts = renderStatsParts(makeReport({ contextPercent: null }));
		expect(parts.some((p) => p.startsWith("Context:"))).toBe(false);
	});

	it("includes compactions when non-zero", () => {
		const parts = renderStatsParts(makeReport({ compactionCount: 2 }));
		expect(parts).toContain("Compactions: 2");
	});

	it("omits compactions when zero", () => {
		const parts = renderStatsParts(makeReport({ compactionCount: 0 }));
		expect(parts.some((p) => p.startsWith("Compactions:"))).toBe(false);
	});
});

describe("renderReportBody", () => {
	it("shows a still-running note for running status", () => {
		const body = renderReportBody(makeReport({ status: "running", result: undefined }));
		expect(body).toBe("Agent is still running. Use wait: true or check back later.");
	});

	it("shows the error message for error status", () => {
		const body = renderReportBody(makeReport({ status: "error", error: "timeout" }));
		expect(body).toBe("Error: timeout");
	});

	it("shows the trimmed result for completed status", () => {
		const body = renderReportBody(makeReport({ status: "completed", result: "  All done.  " }));
		expect(body).toBe("All done.");
	});

	it("shows a no-output fallback when result is undefined", () => {
		const body = renderReportBody(makeReport({ status: "completed", result: undefined }));
		expect(body).toBe("No output.");
	});
});

describe("formatAgentReport", () => {
	it("assembles the full header, stats line, description, and body", () => {
		const text = formatAgentReport(
			makeReport({
				id: "agent-1",
				displayName: "General",
				status: "completed",
				toolUses: 3,
				tokens: "33.8k token",
				contextPercent: 42.6,
				compactionCount: 1,
				duration: "12.3s",
				description: "Investigate the bug",
				result: "All done.",
			}),
		);
		expect(text).toBe(
			"Agent: agent-1\n" +
				"Type: General | Status: completed | Tool uses: 3 | 33.8k token | Context: 43% | Compactions: 1 | Duration: 12.3s\n" +
				"Description: Investigate the bug\n\n" +
				"All done.",
		);
	});

	it("appends the conversation block when present", () => {
		const text = formatAgentReport(
			makeReport({ conversation: "[User]: hello" }),
		);
		expect(text).toContain("\n\n--- Agent Conversation ---\n[User]: hello");
	});

	it("omits the conversation block when absent", () => {
		const text = formatAgentReport(makeReport({ conversation: undefined }));
		expect(text).not.toContain("--- Agent Conversation ---");
	});
});
