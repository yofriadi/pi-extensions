import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __herdrTest__ } from "../src/herdr.ts";

const { classifyHerdrFailure, getPaneRetryBudget, withPaneRetries, extractHerdrPaneId } = __herdrTest__;

describe("herdr pane retry classification", () => {
	it("classifies socket/control-plane and missing pane_id as transient", () => {
		assert.equal(classifyHerdrFailure(new Error("connect ECONNREFUSED socket")), "transient");
		assert.equal(classifyHerdrFailure(new Error("Unexpected herdr pane split output: (empty)")), "transient");
	});

	it("classifies usage errors as permanent", () => {
		assert.equal(classifyHerdrFailure(new Error("unknown flag --ratiox")), "permanent");
		assert.equal(classifyHerdrFailure(new Error("Usage: herdr pane split")), "permanent");
	});

	it("retries transient then succeeds; permanent fails immediately", () => {
		let n = 0;
		const result = withPaneRetries("pane split", () => {
			n += 1;
			if (n < 3) throw new Error("ECONNRESET control-plane");
			return "ok";
		});
		assert.equal(result, "ok");
		assert.equal(n, 3); // initial + 2 retries (default budget 2)

		let permanentCalls = 0;
		assert.throws(
			() =>
				withPaneRetries("pane split", () => {
					permanentCalls += 1;
					throw new Error("unknown flag --bogus");
				}),
			/permanent/,
		);
		assert.equal(permanentCalls, 1);
	});

	it("treats exit-0-without-pane-id as failure via extractHerdrPaneId", () => {
		assert.throws(
			() => extractHerdrPaneId(JSON.stringify({ id: "cli:pane:split", result: { type: "ok" } }), "pane split"),
			/Unexpected herdr pane split output/,
		);
		// And the classifier routes that message as transient (retryable)
		try {
			extractHerdrPaneId('{"result":{}}', "pane split");
		} catch (e) {
			assert.equal(classifyHerdrFailure(e), "transient");
		}
	});

	it("honors PI_SUBAGENT_HERDR_PANE_RETRIES", () => {
		const prev = process.env.PI_SUBAGENT_HERDR_PANE_RETRIES;
		process.env.PI_SUBAGENT_HERDR_PANE_RETRIES = "0";
		try {
			assert.equal(getPaneRetryBudget(), 0);
			let calls = 0;
			assert.throws(
				() =>
					withPaneRetries("tab create", () => {
						calls += 1;
						throw new Error("socket down");
					}),
				/after 1 attempt/,
			);
			assert.equal(calls, 1);
		} finally {
			if (prev == null) delete process.env.PI_SUBAGENT_HERDR_PANE_RETRIES;
			else process.env.PI_SUBAGENT_HERDR_PANE_RETRIES = prev;
		}
	});
});

describe("herdr subprocess timeout", () => {
	it("herdrExecAsync rejects for a non-existent pane and is bounded by the 5s timeout", async () => {
		// Verify herdrExecAsync is exported and callable. A non-existent pane
		// causes herdr to exit non-zero immediately; the 5s timeout ensures the
		// promise settles even if herdr were to hang.
		assert.ok(typeof __herdrTest__.herdrExecAsync === "function", "herdrExecAsync is exported");
		const start = Date.now();
		await assert.rejects(
			__herdrTest__.herdrExecAsync(["pane", "get", "w-test:nonexistent"]),
			/herdr/,
			"herdrExecAsync rejects on a non-existent pane",
		);
		const elapsed = Date.now() - start;
		// The call should return quickly (error path), well within the 5s timeout.
		assert.ok(elapsed < 5000, `herdrExecAsync settled in ${elapsed}ms, within the 5s timeout bound`);
	});

	it("execFileAsync timeout kills subprocesses that exceed the deadline", async () => {
		// Directly verify that Node's execFile timeout mechanism (used by
		// herdrExecAsync) kills a sleeping subprocess and rejects with ETIMEDOUT.
		// This proves the timeout actually terminates the child, not just the promise.
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		const start = Date.now();
		await assert.rejects(
			execFileAsync("sleep", ["10"], { encoding: "utf8", timeout: 200 }),
			(err: any) => {
				// Node kills the process and rejects with an error containing 'ETIMEDOUT'
				// or 'SIGTERM' (the signal used to kill the timed-out process).
				const msg = err?.message ?? String(err);
				return msg.includes("ETIMEDOUT") || msg.includes("SIGTERM") || err?.killed === true;
			},
			"execFileAsync with timeout should kill the sleeping subprocess",
		);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000, `timeout fired in ${elapsed}ms, not after the full 10s sleep`);
	});
});
