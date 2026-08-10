import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../src/index.ts";

const testApi = (subagentsModule as any).__test__;
const resolveResultPresentation: (
	result: {
		exitCode: number;
		elapsed: number;
		summary: string;
		sessionFile?: string;
		errorMessage?: string;
		watchAbandoned?: boolean;
	},
	name: string,
	runId?: string,
) => string = testApi.resolveResultPresentation;

describe("resolveResultPresentation — abandoned watch is not a reported failure", () => {
	const base = {
		exitCode: 1,
		elapsed: 14_400,
		summary: "Reviewed three files; found two issues.",
		sessionFile: "/tmp/child.jsonl",
		errorMessage:
			"Subagent recorded no completion evidence within 4h; stopped watching. " +
			"The pane may still be open — inspect it directly.",
	};

	it("reports unknown outcome rather than claiming the run produced nothing", () => {
		const text = resolveResultPresentation({ ...base, watchAbandoned: true }, "reviewer", "run-1");
		assert.match(text, /watch abandoned/i, "names the actual condition");
		assert.match(text, /outcome is unknown/i, "states the outcome is unknown");
		assert.doesNotMatch(
			text,
			/did not produce a result/i,
			"must not assert the child produced nothing — it may have produced real output",
		);
		assert.doesNotMatch(
			text,
			/provider\/agent error/i,
			"an expired watch is not a provider error and must not be presented as one",
		);
	});

	it("keeps the recovered summary and session pointer", () => {
		const text = resolveResultPresentation({ ...base, watchAbandoned: true }, "reviewer", "run-1");
		assert.match(text, /Reviewed three files/, "any output the child did produce is preserved");
		assert.match(text, /\/tmp\/child\.jsonl/, "session log is discoverable for recovery");
		assert.match(text, /pane was\s+left open/i, "tells the user the pane is still inspectable");
	});

	it("still presents a genuine provider error as a failure", () => {
		// The abandoned branch must not swallow real provider errors, which carry
		// the same errorMessage field.
		const text = resolveResultPresentation(base, "reviewer", "run-1");
		assert.match(text, /provider\/agent error/i);
		assert.doesNotMatch(text, /watch abandoned/i);
	});

	it("leaves normal completions untouched", () => {
		const text = resolveResultPresentation(
			{ exitCode: 0, elapsed: 12, summary: "All good.", sessionFile: "/tmp/c.jsonl" },
			"reviewer",
			"run-2",
		);
		assert.match(text, /completed/);
		assert.doesNotMatch(text, /watch abandoned/i);
	});
});

const resolveSettlementDisposition: (reason: string) => {
	watchAbandoned: boolean;
	preservePane: boolean;
	releaseAdmissionNow: boolean;
} = testApi.resolveSettlementDisposition;

describe("resolveSettlementDisposition — pane and capacity policy", () => {
	it("releases capacity immediately for an abandoned watch", () => {
		// The leak this prevents: a timed-out child is the one most likely never to
		// exit, so tying its slot to pane closure holds a background slot forever.
		// Four of them would block all later background work permanently.
		const d = resolveSettlementDisposition("timeout");
		assert.equal(d.releaseAdmissionNow, true, "admission must not wait for pane closure");
		assert.equal(d.watchAbandoned, true);
	});

	it("keeps the abandoned run's pane instead of reaping it", () => {
		// We do not know the run failed — only that we stopped watching. The child
		// may hold live work, and killing it is unrecoverable while leaving a pane
		// costs only a pane.
		assert.equal(resolveSettlementDisposition("timeout").preservePane, true);
	});

	it("keeps a reported error's pane but frees its admission slot", () => {
		// The child has exited, so the pane is inspectable but dead — yet leaving the
		// admission slot held until the user closes that pane lets a handful of error
		// panes block all later work. Only the session lease follows pane closure.
		const d = resolveSettlementDisposition("error");
		assert.equal(d.preservePane, true);
		assert.equal(d.releaseAdmissionNow, true);
		assert.equal(d.watchAbandoned, false);
	});

	for (const reason of ["done", "ping", "sentinel"]) {
		it(`closes the pane normally for a ${reason} completion`, () => {
			const d = resolveSettlementDisposition(reason);
			assert.equal(d.preservePane, false, "a normal completion must still be reaped");
			assert.equal(d.watchAbandoned, false);
			assert.equal(d.releaseAdmissionNow, false, "normal close/reap frees capacity via the usual path");
		});
	}
});
