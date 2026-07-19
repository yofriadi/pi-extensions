/**
 * get-result-report.ts — Pure report assembly for get_subagent_result.
 *
 * All functions are stateless: they receive an AgentReport, returning
 * formatted strings. No SDK types, no timers, no side effects.
 * Consumed by GetResultTool.execute in get-result-tool.ts. Mirrors the
 * result-renderer.ts pattern used by the subagent tool's TUI renderer.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent";

/** The data a get_subagent_result report renders from — only what the formatter reads. */
export interface AgentReport {
	id: string;
	displayName: string;
	status: SubagentStatus;
	toolUses: number;
	/** Pre-formatted lifetime token total; "" when zero. */
	tokens: string;
	contextPercent: number | null;
	compactionCount: number;
	/** Pre-formatted duration string. */
	duration: string;
	description: string;
	result: string | undefined;
	error: string | undefined;
	/** Present only when verbose was requested and a conversation is available. */
	conversation?: string;
}

/** Assemble the stats parts: Tool uses / tokens? / Context? / Compactions? / Duration. */
export function renderStatsParts(report: AgentReport): string[] {
	const parts = [`Tool uses: ${report.toolUses}`];
	if (report.tokens) parts.push(report.tokens);
	if (report.contextPercent !== null) parts.push(`Context: ${Math.round(report.contextPercent)}%`);
	if (report.compactionCount) parts.push(`Compactions: ${report.compactionCount}`);
	parts.push(`Duration: ${report.duration}`);
	return parts;
}

/** Select the per-status body: running note, error line, or trimmed result. */
export function renderReportBody(report: AgentReport): string {
	if (report.status === "running")
		return "Agent is still running. Use wait: true or check back later.";
	if (report.status === "error") return `Error: ${report.error}`;
	return report.result?.trim() ?? "No output.";
}

/** Assemble the full get_subagent_result report text. */
export function formatAgentReport(report: AgentReport): string {
	let output =
		`Agent: ${report.id}\n` +
		`Type: ${report.displayName} | Status: ${report.status} | ${renderStatsParts(report).join(" | ")}\n` +
		`Description: ${report.description}\n\n`;
	output += renderReportBody(report);
	if (report.conversation) {
		output += `\n\n--- Agent Conversation ---\n${report.conversation}`;
	}
	return output;
}
