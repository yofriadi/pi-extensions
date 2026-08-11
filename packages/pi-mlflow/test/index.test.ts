import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace as otelTrace } from "@opentelemetry/api";
import { InMemoryTraceManager } from "mlflow-tracing/dist/core/trace_manager.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piMlflow from "../src/index.ts";
import { resetSetupCacheForTests } from "../src/setup.ts";

/**
 * Minimal in-test double for `ExtensionAPI`, enough to drive `piMlflow`'s
 * `session_start` handler and inspect the registered `/mlflow` command.
 */
class FakeExtensionAPI {
	private handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	async fire(event: string, payload: unknown, ctx: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

function makeCtx(cwd: string, isProjectTrusted: boolean) {
	return {
		cwd,
		isProjectTrusted: () => isProjectTrusted,
		sessionManager: { getSessionId: () => "session-1" },
	};
}

describe("piMlflow project trust boundary", () => {
	let dir: string;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-mlflow-index-"));
		resetSetupCacheForTests();
		fetchMock = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response(JSON.stringify({ experiment: { experiment_id: "1" } }), { status: 200 })),
			);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		InMemoryTraceManager.reset();
		// Tests may call setupTracing() -> mlflow.init(), which registers a
		// global OpenTelemetry tracer provider; unregister it so it doesn't leak
		// into (and block) the next test's own init() call.
		otelTrace.disable();
		await rm(dir, { recursive: true, force: true });
	});

	it("does not read pi-mlflow.json or contact the tracking server in an untrusted project", async () => {
		await writeFile(
			join(dir, "pi-mlflow.json"),
			JSON.stringify({ trackingUri: "https://attacker.example", captureContent: true }),
		);

		const pi = new FakeExtensionAPI();
		piMlflow(pi as never);
		await pi.fire("session_start", { type: "session_start" }, makeCtx(dir, false));

		expect(fetchMock).not.toHaveBeenCalled();

		// /mlflow must report disabled, not silently succeed against the
		// attacker-supplied config, and must not show the untrusted trackingUri
		// as if it were active.
		const status = pi.commands.get("mlflow")!;
		const notify = vi.fn();
		await status.handler("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "warning");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("not trusted"), "warning");
	});

	it("loads pi-mlflow.json and initializes tracing in a trusted project", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "trusted-project" }));

		const pi = new FakeExtensionAPI();
		piMlflow(pi as never);
		await pi.fire("session_start", { type: "session_start" }, makeCtx(dir, true));

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps tool-span tracking independent across two extension instances sharing the process-global setup cache", async () => {
		// Reproduces the scenario the process-global setup cache (src/setup.ts)
		// exists for: `piMlflow()`'s factory running more than once in the same
		// process (e.g. `/reload`, or two loaded copies of the extension). The
		// second instance's `setupTracing()` call resolves from cache instead of
		// re-hitting the network, but each instance must still get its own
		// independent `toolSpans` map — a shared one would let a tool_execution_start
		// in one instance's trace show up as an open span in the other's.
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "shared-cache" }));

		const piA = new FakeExtensionAPI();
		piMlflow(piA as never);
		await piA.fire("session_start", { type: "session_start" }, makeCtx(dir, true));

		const piB = new FakeExtensionAPI();
		piMlflow(piB as never);
		await piB.fire("session_start", { type: "session_start" }, makeCtx(dir, true));

		// Only one network round-trip: the second instance's setupTracing() call
		// was served from the process-global cache, proving they do share it.
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Drive A into a turn with one open tool call, then drive B through an
		// entire turn-cycle with zero tool calls. If the two instances shared the
		// same toolSpans Map (the bug being guarded against), B's turn_end would
		// force-close A's still-open tool span as "incomplete" before A ever got
		// to end it itself with its real (successful) result.
		await piA.fire("agent_start", { type: "agent_start" }, makeCtx(dir, true));
		const manager = InMemoryTraceManager.getInstance() as unknown as { _traces: Map<string, unknown> };
		const traceIdsA = Array.from(manager._traces.keys());
		const traceIdA = traceIdsA[traceIdsA.length - 1]!;
		await piA.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await piA.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "only-in-A",
			toolName: "bash",
			args: {},
		});

		await piB.fire("agent_start", { type: "agent_start" }, makeCtx(dir, true));
		await piB.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await piB.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		await piB.fire("agent_settled", { type: "agent_settled" });

		// A's tool call finishes normally afterward with a real result.
		await piA.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "only-in-A",
			toolName: "bash",
			result: "ok",
			isError: false,
		});
		await piA.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});

		const toolSpanA = Array.from(InMemoryTraceManager.getInstance().getTrace(traceIdA)!.spanDict.values()).find(
			(s) => s.name === "bash",
		)!;
		// If B's turn_end had force-closed A's shared map entry, this would be
		// ERROR/"pi.span.incomplete" instead of the real successful OK status.
		expect(toolSpanA.status.statusCode).toBe("STATUS_CODE_OK");
		expect(toolSpanA.attributes["pi.span.incomplete"]).toBeUndefined();

		await piA.fire("agent_settled", { type: "agent_settled" });
	});
});
