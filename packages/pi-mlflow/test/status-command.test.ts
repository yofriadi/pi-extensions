import { describe, expect, it } from "vitest";
import { SERVER_WAIT_GRACE_MS } from "../src/constants.ts";
import { createInitialState } from "../src/state.ts";
import { buildStatusLines } from "../src/status-command.ts";

describe("buildStatusLines", () => {
	it("reports active status with config fields and never invents span content", () => {
		const state = createInitialState({
			trackingUri: "http://localhost:5000",
			experimentName: "pi",
			captureContent: true,
		});
		state.enabled = true;
		state.experimentId = "42";

		const lines = buildStatusLines(state);
		const text = lines.join("\n");

		expect(text).toContain("tracking URI: http://localhost:5000");
		expect(text).toContain("experiment: pi (id: 42)");
		expect(text).toContain("capture content: enabled");
		expect(text).toContain("Sessions conversation text");
		expect(text).toContain("status: active");
		// Status surface is config-only — no span I/O, prompts, or tool bodies.
		expect(text).not.toMatch(/tool arg|payload|span content/i);
		expect(text).not.toMatch(/\binputs\b|\boutputs\b/i);
		expect(text).not.toContain("disabled");
	});

	it("reports disabled status with reason and omits active-only fields", () => {
		const state = createInitialState({
			trackingUri: "http://localhost:5000",
			experimentName: "pi",
			captureContent: false,
		});
		state.enabled = false;
		state.disabledReason = "tracking server unreachable or misconfigured at startup (connect ECONNREFUSED)";

		const lines = buildStatusLines(state);
		const text = lines.join("\n");

		expect(text).toContain("capture content: disabled");
		expect(text).toContain("Sessions conversation text");
		expect(text).toContain(
			"status: disabled (tracking server unreachable or misconfigured at startup (connect ECONNREFUSED))",
		);
		expect(text).not.toContain("status: active");
		// No stale "last flush" / active-style fields when disabled.
		expect(text).not.toMatch(/last flush|last export/i);
		expect(text).not.toMatch(/\bspan id\b|active span/i);
	});

	it("falls back to 'unknown reason' when disabled without a reason string", () => {
		const state = createInitialState({
			trackingUri: "",
			experimentName: "",
			captureContent: false,
		});
		state.enabled = false;

		const text = buildStatusLines(state).join("\n");
		expect(text).toContain("status: disabled (unknown reason)");
	});

	it("redacts userinfo credentials from tracking URI", () => {
		const state = createInitialState({
			trackingUri: "https://user:token@mlflow.example:5000",
			experimentName: "pi",
			captureContent: false,
		});
		state.enabled = true;
		state.experimentId = "1";

		const text = buildStatusLines(state).join("\n");
		expect(text).toContain("tracking URI: https://mlflow.example:5000/");
		expect(text).not.toContain("user:token");
		expect(text).not.toContain("token@");
	});

	it("shows (none) placeholders when tracking URI / experiment are empty", () => {
		const state = createInitialState({
			trackingUri: "",
			experimentName: "",
			captureContent: false,
		});
		state.enabled = false;
		state.disabledReason = "project is not trusted; pi-mlflow.json is not loaded from untrusted projects";

		const text = buildStatusLines(state).join("\n");
		expect(text).toContain("tracking URI: (none)");
		expect(text).toContain("experiment: (none)");
		expect(text).not.toMatch(/\(id:/);
	});
});

describe("degraded flush line (bound-settle-flush-latency)", () => {
	const activeState = (flushWaitExceeded: boolean) => {
		const state = createInitialState({
			trackingUri: "http://localhost:5000",
			experimentName: "pi",
			captureContent: true,
		});
		state.enabled = true;
		state.flushWaitExceeded = flushWaitExceeded;
		return state;
	};

	it("renders the degraded line while tracing is active (2.2/3.7)", () => {
		const lines = buildStatusLines(activeState(true));
		const text = lines.join("\n");

		expect(text).toContain("status: active");
		expect(text).toContain(
			`last flush wait exceeded the ${SERVER_WAIT_GRACE_MS}ms bound (export continuing in background)`,
		);
		// Exactly one degraded line — not one per degradation or attempt.
		expect(lines.filter((line) => line.includes("last flush wait"))).toHaveLength(1);
		// Content-exclusion contract: config/status fields only, never captured
		// trace content (tool arguments, payloads, prompts, span bodies).
		expect(text).not.toMatch(/tool arg|payload|span content|user prompt/i);
		expect(text).not.toMatch(/\binputs\b|\boutputs\b/i);
	});

	it("renders no degraded line while active without degradation (3.7)", () => {
		const text = buildStatusLines(activeState(false)).join("\n");

		expect(text).toContain("status: active");
		expect(text).not.toMatch(/last flush|bound|background/i);
		expect(text).not.toMatch(/tool arg|payload|span content|user prompt/i);
	});

	it("never renders the degraded line while disabled, even with a stale flag set (2.2/3.7)", () => {
		const state = activeState(true);
		state.enabled = false;
		state.disabledReason = "tracking server unreachable or misconfigured at startup (connect ECONNREFUSED)";
		const lines = buildStatusLines(state);
		const text = lines.join("\n");

		expect(text).toContain(
			"status: disabled (tracking server unreachable or misconfigured at startup (connect ECONNREFUSED))",
		);
		expect(text).not.toContain("status: active");
		expect(text).not.toMatch(/last flush|bound|background/i);
		// Disabled output is exactly status + reason: no active-style fields.
		expect(lines).toHaveLength(5);
	});
});
