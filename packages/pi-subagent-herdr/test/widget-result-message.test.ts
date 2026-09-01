import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderSubagentResultMessage, renderSubagentToolResult } from "../src/widget.ts";
import { createPlainWidgetTheme } from "./widget-theme.ts";

const theme = createPlainWidgetTheme();
initTheme("dark");

function renderedResult(message: any, expanded = false): string {
	return renderSubagentResultMessage(message, { expanded }, theme, 120).join("\n");
}

describe("subagent result renderers", () => {
	it("renders a collapsed successful background result without repeating its transport prefix", () => {
		const output = renderedResult({
			content:
				'Sub-agent "Reviewer" [run-1] completed (3s).\n\nReviewed the change.\n\nSession log: /tmp/child.jsonl',
			details: { name: "Reviewer", id: "run-1", elapsed: 3, agent: "reviewer" },
		});

		assert.match(output, /Reviewer \(reviewer\) \[run-1\] — completed \(3s\)/);
		assert.match(output, /Reviewed the change\./);
		assert.doesNotMatch(output, /Sub-agent "Reviewer" \[run-1\] completed/);
		assert.match(output, /to expand/);
	});

	it("renders expanded provider failures with their session log", () => {
		const output = renderedResult(
			{
				content:
					'Sub-agent "Reviewer" [run-2] failed after 5s (provider/agent error — auto-retry exhausted after 3 attempts).\n\nRate limited.',
				details: {
					name: "Reviewer",
					id: "run-2",
					elapsed: 5,
					exitCode: 1,
					errorMessage: "Rate limited",
					sessionFile: "/tmp/failed-child.jsonl",
					attempts: 3,
					maxAttempts: 3,
				},
			},
			true,
		);

		assert.match(output, /failed \(provider\/agent error\)/);
		assert.match(output, /Rate limited\./);
		assert.match(output, /Session log: \/tmp\/failed-child.jsonl/);
		assert.doesNotMatch(output, /auto-retry exhausted/);
	});

	it("strips the non-exhausted provider-failure first line without an exhaustion claim", () => {
		// A non-retried failure (malformed sidecar, pane disappearance, errored
		// watch) prints `(provider/agent error)` — no exhaustion statement — and
		// the widget must still strip that first line without duplicating it.
		const output = renderedResult(
			{
				content:
					'Sub-agent "Reviewer" [run-9] failed after 7s (provider/agent error).\n\nSubagent pane disappeared.',
				details: {
					name: "Reviewer",
					id: "run-9",
					elapsed: 7,
					exitCode: 1,
					errorMessage: "Subagent pane disappeared.",
				},
			},
			true,
		);

		assert.match(output, /failed \(provider\/agent error\)/);
		assert.match(output, /Subagent pane disappeared\./);
		assert.doesNotMatch(output, /auto-retry exhausted/);
		// The duplicated presentation first line is stripped from the summary.
		assert.doesNotMatch(output, /Sub-agent "Reviewer" \[run-9\] failed after 7s/);
	});

	it("keeps abandoned outcomes distinct from failures", () => {
		const output = renderedResult({
			content: "The child may still be running.",
			details: { name: "Reviewer", id: "run-3", elapsed: 9, watchAbandoned: true, exitCode: 1 },
		});

		assert.match(output, /watch abandoned \(outcome unknown\)/);
		assert.doesNotMatch(output, /failed \(exit/);
	});

	it("renders started, blocking failure, and ordinary tool result presentations", () => {
		const started = renderSubagentToolResult(
			{
				content: [],
				details: { name: "Reviewer", id: "run-4", status: "started", model: "test/model", thinking: "low" },
			},
			{},
			theme,
		).render(120);
		assert.match(started.join("\n"), /Reviewer \[run-4\].*test\/model.*low/);

		const blocking = renderSubagentToolResult(
			{
				content: [{ type: "text", text: "Line one\nLine two" }],
				details: { name: "Reviewer", id: "run-5", status: "error", blocking: true, agent: "reviewer" },
				isError: true,
			},
			{},
			theme,
		).render(120);
		assert.match(blocking.join("\n"), /Reviewer \(reviewer\) \[run-5\] — failed \(blocking\)/);
		assert.match(blocking.join("\n"), /Line one/);

		const ordinary = renderSubagentToolResult(
			{ content: [{ type: "text", text: "Queued" }], details: {} },
			{},
			theme,
		).render(120);
		assert.equal(ordinary.join("\n").trimEnd(), "Queued");
	});
});
