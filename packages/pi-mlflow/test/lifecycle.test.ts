import * as mlflow from "mlflow-tracing";
import { InMemoryTraceManager } from "mlflow-tracing/dist/core/trace_manager.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PiMlflowConfig } from "../src/config.ts";
import { extractAssistantText, registerLifecycleHandlers } from "../src/lifecycle.ts";
import { createInitialState } from "../src/state.ts";

/**
 * Minimal in-test double for `ExtensionAPI`: records handlers registered via
 * `on(event, handler)` so tests can fire pi lifecycle events directly without
 * spinning up a real pi session.
 */
class FakeExtensionAPI {
	private handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	async fire(event: string, payload: unknown, ctx: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

function makeCtx(sessionId = "session-1") {
	return { sessionManager: { getSessionId: () => sessionId } };
}

/**
 * Snapshot the given trace's spans while the trace is still registered in the
 * SDK's in-memory manager. Ending the root span pops the trace from that
 * manager synchronously (export to the backend happens asynchronously
 * afterward), so callers must capture this *before* firing `agent_settled`
 * or `session_shutdown`.
 */
function snapshotTraceSpans(traceId: string) {
	const trace = InMemoryTraceManager.getInstance().getTrace(traceId);
	if (!trace) throw new Error("trace not found — call this before ending the root span");
	return trace.toMlflowTrace();
}

function stubExporter(): void {
	// Swallow explicit flush export attempts. Root-end still queues a background
	// export against 127.0.0.1:1 (SDK behavior); that path is best-effort only.
	// Individual tests may re-spy flush; afterEach re-applies this default.
	vi.spyOn(mlflow, "flushTraces").mockResolvedValue(undefined);
}

beforeAll(() => {
	// Point at an address that will simply fail exports in the background;
	// spans and trace metadata are still recorded synchronously in-memory by
	// the SDK regardless of export success, which is what these tests assert.
	mlflow.init({ trackingUri: "http://127.0.0.1:1", experimentId: "0" });
	stubExporter();
});

afterEach(() => {
	stubExporter();
});

function makeConfig(captureContent: boolean): PiMlflowConfig {
	return { trackingUri: "http://127.0.0.1:1", experimentName: "test", captureContent };
}

describe("lifecycle captureContent gating (task 4.4 / trace-metadata spec)", () => {
	it("omits tool argument/output content when captureContent is false", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "/etc/secret" },
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "super secret file contents",
			isError: false,
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const toolSpan = trace.data.spans.find((s) => s.name === "read");
		expect(toolSpan).toBeDefined();
		expect(toolSpan!.inputs).toBeUndefined();
		expect(toolSpan!.outputs).toBeUndefined();
	});

	it("includes tool argument/output content when captureContent is true", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "read",
			args: { path: "/etc/secret" },
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "read",
			result: "super secret file contents",
			isError: false,
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const toolSpan = trace.data.spans.find((s) => s.name === "read");
		expect(toolSpan).toBeDefined();
		expect(toolSpan!.inputs).toEqual({ path: "/etc/secret" });
		expect(toolSpan!.outputs).toBe("super secret file contents");
	});

	it("omits LLM message content when captureContent is false but keeps token usage/cost", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "the secret answer is 42" }],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm");
		expect(llmSpan).toBeDefined();
		expect(llmSpan!.inputs).toBeUndefined();
		expect(llmSpan!.outputs).toBeUndefined();
		expect(llmSpan!.attributes["mlflow.chat.tokenUsage"]).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
		});
		expect(llmSpan!.attributes["mlflow.llm.cost"]).toEqual({
			input_cost: 0.001,
			output_cost: 0.002,
			total_cost: 0.003,
		});
	});

	it("opens the LLM span at before_provider_request (request payload as input) and closes it at message_end (response as output)", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		await pi.fire(
			"before_provider_request",
			{ payload: { model: "claude-x", messages: [{ role: "user", content: "hi" }] } },
			{ thinkingLevel: "high" },
		);
		const openedSpanId = state.activeLlmSpan!.spanId;

		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello there" }],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});

		expect(state.activeLlmSpan).toBeUndefined();

		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm")!;
		expect(llmSpan.spanId).toBe(openedSpanId);
		expect(llmSpan.inputs).toEqual({ model: "claude-x", messages: [{ role: "user", content: "hi" }] });
		expect(llmSpan.outputs).toEqual([{ type: "text", text: "hello there" }]);
		expect(llmSpan.attributes["pi.llm.thinkingLevel"]).toBe("high");
	});

	it("falls back to opening the LLM span at message_end when before_provider_request never fired", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		// No before_provider_request fired — e.g. an older pi build.
		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm");
		expect(llmSpan).toBeDefined();
		expect(llmSpan!.attributes["mlflow.chat.tokenUsage"]).toEqual({
			input_tokens: 1,
			output_tokens: 1,
			total_tokens: 2,
		});
	});

	it("records the final HTTP status on the next LLM span, without response bodies", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		// pi's provider layer retries failed HTTP calls (e.g. a 429) internally
		// and only fires after_provider_response once, for the call that
		// eventually succeeded — failed attempts never reach extensions. So only
		// a single final status is ever observable here, not a retry history.
		await pi.fire("after_provider_response", { status: 200 });

		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm")!;
		expect(llmSpan.attributes["pi.llm.httpStatusCode"]).toBe(200);
		// No retry-count field is fabricated — pi's extension API can't observe
		// per-attempt retries, so we don't claim to report one.
		expect(llmSpan.attributes["pi.llm.httpRetryCount"]).toBeUndefined();
	});

	it("does not attach an HTTP status attribute when after_provider_response never fired", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm")!;
		expect(llmSpan.attributes["pi.llm.httpStatusCode"]).toBeUndefined();
	});
});

describe("lifecycle span tree structure", () => {
	it("records pi.turn.toolResultCount as always-on structural metadata even when captureContent is false", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			// Structural count only — shape matches TurnEndEvent.toolResults length.
			toolResults: [{}, {}, {}] as never,
		});
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const turnSpan = trace.data.spans.find((s) => s.name === "pi.turn" || s.name.startsWith("pi.turn"))!;
		expect(turnSpan.attributes["pi.turn.toolResultCount"]).toBe(3);
		// Must not land in content-gated outputs.
		expect(turnSpan.outputs).toBeUndefined();
	});

	it("opens the root span without waiting on git provenance (off critical path)", async () => {
		let resolveGit!: () => void;
		const gitGate = new Promise<void>((resolve) => {
			resolveGit = resolve;
		});

		const pi = new FakeExtensionAPI();
		// Slow git: hang until the test releases the gate. All three execs share
		// the same gate; once released, they all complete immediately.
		(pi as unknown as { exec: (...args: unknown[]) => Promise<unknown> }).exec = async (
			_command: unknown,
			args: unknown,
		) => {
			await gitGate;
			const key = (args as string[]).join(" ");
			if (key === "rev-parse HEAD") {
				return { stdout: "abc123\n", stderr: "", code: 0, killed: false };
			}
			if (key === "rev-parse --abbrev-ref HEAD") {
				return { stdout: "main\n", stderr: "", code: 0, killed: false };
			}
			if (key === "remote get-url origin") {
				return { stdout: "https://github.com/org/repo.git\n", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		};

		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		// agent_start must resolve while git is still blocked — root open is
		// synchronous, provenance is background.
		await pi.fire("agent_start", { type: "agent_start" }, { ...makeCtx("session-git"), cwd: "/repo" });
		expect(state.rootSpan).toBeDefined();
		expect(state.pendingGitProvenance).toBeDefined();
		expect(state.gitCommit).toBeUndefined();

		// Release git; await the in-flight provenance before settle so we can
		// assert both in-memory state and exported trace metadata keys.
		resolveGit();
		await state.pendingGitProvenance;
		expect(state.gitCommit).toBe("abc123");
		expect(state.gitBranch).toBe("main");
		expect(state.gitRepoUrl).toBe("https://github.com/org/repo.git");

		const rootTraceId = state.rootSpan!.traceId;
		const trace = snapshotTraceSpans(rootTraceId);
		expect(trace.info.traceMetadata["mlflow.source.git.commit"]).toBe("abc123");
		expect(trace.info.traceMetadata["mlflow.source.git.branch"]).toBe("main");
		expect(trace.info.traceMetadata["mlflow.source.git.repoURL"]).toBe("https://github.com/org/repo.git");
		expect(trace.info.traceMetadata["mlflow.trace.session"]).toBe("session-git");

		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(state.pendingGitProvenance).toBeUndefined();
		expect(state.rootSpan).toBeUndefined();
		// Git fields are cleared with the closed root for the next turn-cycle.
		expect(state.gitCommit).toBeUndefined();
	});

	it("awaits git provenance exceeding 100ms before ending the root so branch/commit still attach", async () => {
		const updateSpy = vi.spyOn(mlflow, "updateCurrentTrace");

		const pi = new FakeExtensionAPI();
		(pi as unknown as { exec: (...args: unknown[]) => Promise<unknown> }).exec = async (
			_command: unknown,
			args: unknown,
		) => {
			// Ordinary slow repository: slower than the previous 100ms hard-cap,
			// still well under each git command's own timeout.
			await new Promise((resolve) => setTimeout(resolve, 150));
			const key = (args as string[]).join(" ");
			if (key === "rev-parse HEAD") {
				return { stdout: "def456\n", stderr: "", code: 0, killed: false };
			}
			if (key === "rev-parse --abbrev-ref HEAD") {
				return { stdout: "feature\n", stderr: "", code: 0, killed: false };
			}
			if (key === "remote get-url origin") {
				return { stdout: "https://github.com/org/slow-repo.git\n", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		};

		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		try {
			await pi.fire("agent_start", { type: "agent_start" }, { ...makeCtx("session-slow-git"), cwd: "/repo" });
			expect(state.pendingGitProvenance).toBeDefined();
			expect(state.rootSpan).toBeDefined();
			// Root opened without waiting on the slow git lookup.
			expect(state.gitCommit).toBeUndefined();

			const started = Date.now();
			// Settle must await the already-started >100ms lookup before ending/exporting.
			await pi.fire("agent_settled", { type: "agent_settled" });
			const elapsed = Date.now() - started;

			expect(elapsed).toBeGreaterThanOrEqual(100);
			expect(state.rootSpan).toBeUndefined();
			expect(state.pendingGitProvenance).toBeUndefined();

			const gitUpdate = updateSpy.mock.calls
				.map((call) => call[0]?.metadata ?? {})
				.find((metadata) => metadata["mlflow.source.git.commit"] === "def456");
			expect(gitUpdate).toEqual({
				"mlflow.source.git.commit": "def456",
				"mlflow.source.git.branch": "feature",
				"mlflow.source.git.repoURL": "https://github.com/org/slow-repo.git",
			});
		} finally {
			updateSpy.mockRestore();
		}
	});

	it("awaits real flushTraces completion before agent_settled returns", async () => {
		let resolveFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			resolveFlush = resolve;
		});
		let flushStarted = false;
		let flushCompleted = false;
		const flushSpy = vi.spyOn(mlflow, "flushTraces").mockImplementation(async () => {
			flushStarted = true;
			await flushGate;
			flushCompleted = true;
		});

		try {
			const pi = new FakeExtensionAPI();
			const state = createInitialState(makeConfig(false));
			state.enabled = true;
			registerLifecycleHandlers(pi as never, state);

			await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
			await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
			await pi.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", stopReason: "stop" },
				toolResults: [],
			});

			let settled = false;
			const settlePromise = pi.fire("agent_settled", { type: "agent_settled" }).then(() => {
				settled = true;
			});

			// Allow the settle handler to reach the flush await.
			await vi.waitFor(() => {
				expect(flushStarted).toBe(true);
			});
			expect(settled).toBe(false);
			expect(flushCompleted).toBe(false);

			resolveFlush();
			await settlePromise;
			expect(flushCompleted).toBe(true);
			expect(settled).toBe(true);
			expect(flushSpy).toHaveBeenCalled();
		} finally {
			flushSpy.mockRestore();
		}
	});

	it("ends the root as ERROR when the terminal turn is error or aborted", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const rootEnd = vi.spyOn(root, "end");
		const rootTraceId = root.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "error" },
			toolResults: [],
		});
		expect(state.finalCycleStatus).toBe(mlflow.SpanStatusCode.ERROR);
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const turn = trace.data.spans.find((s) => s.name === "pi.turn");
		expect(turn!.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
		expect(rootEnd).toHaveBeenCalledWith(expect.objectContaining({ status: mlflow.SpanStatusCode.ERROR }));
	});

	it("restores OK root status after a successful recovery turn", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		expect(state.finalCycleStatus).toBe(mlflow.SpanStatusCode.OK);

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "aborted" },
			toolResults: [],
		});
		expect(state.finalCycleStatus).toBe(mlflow.SpanStatusCode.ERROR);

		// Recovery attempt within the same turn-cycle (another agent_start).
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		expect(state.attemptIndex).toBe(1);
		expect(state.rootSpan?.traceId).toBe(rootTraceId);

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		expect(state.turnSpan).toBeDefined();
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		expect(state.finalCycleStatus).toBe(mlflow.SpanStatusCode.OK);

		// Snapshot after the successful recovery turn ends, while the root is still open.
		// (Ending the root at settle pops the trace from the in-memory manager.)
		const root = state.rootSpan!;
		const rootEnd = vi.spyOn(root, "end");
		const live = InMemoryTraceManager.getInstance().getTrace(rootTraceId);
		expect(live).toBeTruthy();
		const trace = live!.toMlflowTrace();
		const turns = trace.data.spans.filter((s) => s.name === "pi.turn");
		expect(turns).toHaveLength(2);
		expect(turns[0]!.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
		expect(turns[1]!.status.statusCode).toBe(mlflow.SpanStatusCode.OK);

		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(rootEnd).toHaveBeenCalledWith(expect.objectContaining({ status: mlflow.SpanStatusCode.OK }));
		expect(state.rootSpan).toBeUndefined();
		expect(state.finalCycleStatus).toBe(mlflow.SpanStatusCode.OK);
	});

	it("creates two independent traces for two prompts in the same session", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-shared"));
		const firstTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const firstTrace = snapshotTraceSpans(firstTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(state.rootSpan).toBeUndefined();

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-shared"));
		const secondTraceId = state.rootSpan!.traceId;
		expect(secondTraceId).not.toBe(firstTraceId);
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const secondTrace = snapshotTraceSpans(secondTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		expect(firstTrace.info.traceMetadata["mlflow.trace.session"]).toBe("session-shared");
		expect(secondTrace.info.traceMetadata["mlflow.trace.session"]).toBe("session-shared");
		expect(firstTrace.data.spans.some((s) => s.name === "pi.agent")).toBe(true);
		expect(secondTrace.data.spans.some((s) => s.name === "pi.agent")).toBe(true);
	});

	it("nests turn/LLM/tool spans under the root AGENT span and sets session metadata", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-abc"));
		const rootTraceId = state.rootSpan!.traceId;
		const rootSpanId = state.rootSpan!.spanId;

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		const turnSpanId = state.turnSpan!.spanId;

		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: "ok",
			isError: false,
		});
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		expect(trace.info.traceMetadata["mlflow.trace.session"]).toBe("session-abc");

		const spans = trace.data.spans;
		const turnSpan = spans.find((s) => s.spanId === turnSpanId)!;
		expect(turnSpan.parentId).toBe(rootSpanId);
		const toolSpan = spans.find((s) => s.name === "bash")!;
		expect(toolSpan.parentId).toBe(turnSpanId);
	});

	it("force-closes a tool span still open when turn_end fires (D3 mitigation)", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "dangling",
			toolName: "bash",
			args: {},
		});
		// No tool_execution_end fires before turn_end.
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });

		expect(state.toolSpans.size).toBe(0);
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const toolSpan = trace.data.spans.find((s) => s.name === "bash")!;
		expect(toolSpan.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
	});

	it("tracks concurrent tool spans independently when they finish out of start order (D3 Map, not LIFO)", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		// Start two tools in order A then B.
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "read",
			args: { path: "/a" },
		});
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-b",
			toolName: "bash",
			args: { command: "echo b" },
		});
		expect(state.toolSpans.size).toBe(2);

		// End B first, then A — completion order inverted vs start order. A LIFO
		// stack would close the wrong span / attach the wrong outputs here.
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-b",
			toolName: "bash",
			result: "b-output",
			isError: false,
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-a",
			toolName: "read",
			result: "a-output",
			isError: false,
		});
		expect(state.toolSpans.size).toBe(0);

		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const readSpan = trace.data.spans.find((s) => s.name === "read")!;
		const bashSpan = trace.data.spans.find((s) => s.name === "bash")!;
		expect(readSpan.outputs).toBe("a-output");
		expect(bashSpan.outputs).toBe("b-output");
		expect(readSpan.status.statusCode).toBe(mlflow.SpanStatusCode.OK);
		expect(bashSpan.status.statusCode).toBe(mlflow.SpanStatusCode.OK);
	});

	it("force-closes a dangling LLM span when a second before_provider_request fires without message_end", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		// Simulate post-compaction retry metadata + HTTP status belonging to the
		// first (dangling) request — both must be dropped on force-close so they
		// are not attributed to the second request.
		state.pendingAttemptReason = "post_compaction";
		await pi.fire("before_provider_request", { payload: { attempt: 1 } }, { thinkingLevel: undefined });
		const firstSpanId = state.activeLlmSpan!.spanId;
		await pi.fire("after_provider_response", { status: 429 });
		expect(state.lastHttpStatus).toBe(429);

		// Second request start with no intervening message_end — the defensive
		// force-close must end the first span as incomplete rather than reusing it,
		// and must clear the dangling request's status/attempt metadata.
		await pi.fire("before_provider_request", { payload: { attempt: 2 } }, { thinkingLevel: undefined });
		expect(state.activeLlmSpan).toBeDefined();
		expect(state.activeLlmSpan!.spanId).not.toBe(firstSpanId);
		expect(state.lastHttpStatus).toBeUndefined();
		expect(state.pendingAttemptReason).toBeUndefined();

		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const llmSpans = trace.data.spans.filter((s) => s.name === "pi.llm" || s.name.startsWith("pi.llm_"));
		expect(llmSpans.length).toBe(2);
		const first = llmSpans.find((s) => s.spanId === firstSpanId)!;
		expect(first.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
		expect(first.attributes["pi.span.incomplete"]).toBe(true);
		const second = llmSpans.find((s) => s.spanId !== firstSpanId)!;
		expect(second.status.statusCode).toBe(mlflow.SpanStatusCode.OK);
		expect(second.inputs).toEqual({ attempt: 2 });
		// Must not inherit the dangling request's HTTP status or attempt reason.
		expect(second.attributes["pi.llm.httpStatusCode"]).toBeUndefined();
		expect(second.attributes["pi.attempt.reason"]).toBeUndefined();
	});

	it("force-closes open spans and flushes at session_shutdown (D2 safety net)", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "orphan",
			toolName: "bash",
			args: {},
		});
		// Simulate a mid-turn interrupt: no turn_end, no agent_settled.
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(state.toolSpans.size).toBe(0);
		expect(state.turnSpan).toBeUndefined();
		expect(state.rootSpan).toBeUndefined();

		const spans = trace.data.spans;
		expect(spans.find((s) => s.name === "bash")!.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
		expect(spans.find((s) => s.name === "pi.turn")!.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
		expect(spans.find((s) => s.name === "pi.agent")!.status.statusCode).toBe(mlflow.SpanStatusCode.ERROR);
	});
});

describe("compaction span placement (D4)", () => {
	it("nests overflow compaction under the turn it interrupted, even though pi fires it after turn_end", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		const turnSpanId = state.turnSpan!.spanId;

		// pi's real event order for overflow recovery: the overflowing turn's
		// turn_end fires first, *then* session_compact (see _checkCompaction in
		// pi's agent-session.js, called from _handlePostAgentRun after agent_end).
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "error" },
			toolResults: [],
		});

		await pi.fire("session_compact", {
			type: "session_compact",
			compactionEntry: { tokensBefore: 1000, firstKeptEntryId: "entry-5", summary: "..." },
			fromExtension: false,
			reason: "overflow",
			willRetry: true,
		});

		// The retried LLM call after overflow recovery: pi calls agent.continue(),
		// which fires another agent_start/turn_start pair within the same trace.
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: "claude-x",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: Date.now(),
			},
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const compactionSpan = trace.data.spans.find((s) => s.name === "pi.compaction")!;
		expect(compactionSpan.parentId).toBe(turnSpanId);

		// Only one root/trace should have been created across both agent_start
		// events — the retry must not start a second, disconnected trace (D1).
		const rootSpans = trace.data.spans.filter((s) => s.parentId === null);
		expect(rootSpans).toHaveLength(1);

		// The retried LLM call is tagged as a post-compaction attempt and remains
		// part of the same trace, nested under its own (second) turn.
		// The retried LLM call is tagged as a post-compaction attempt and remains
		// part of the same trace, nested under a *new* turn span (mlflow-tracing
		// spans can't be reopened to literally continue the interrupted turn),
		// but that new turn is parented under the compaction span — which is
		// itself a child of the interrupted turn — so the retry is a true
		// descendant of the turn it overflowed, not a sibling under the root.
		const llmSpan = trace.data.spans.find((s) => s.name === "pi.llm")!;
		expect(llmSpan.attributes["pi.attempt.reason"]).toBe("post_compaction");
		expect(llmSpan.attributes["pi.attempt.index"]).toBe(1);

		const retriedTurnSpan = trace.data.spans.find((s) => s.spanId === llmSpan.parentId)!;
		// Note: MLflow's SDK deduplicates same-named sibling-tree span names
		// within a trace ("pi.turn" -> "pi.turn_2"), hence the name check below
		// only checks the prefix rather than an exact match.
		expect(retriedTurnSpan.name).toMatch(/^pi\.turn/);
		expect(retriedTurnSpan.spanId).not.toBe(turnSpanId);
		expect(retriedTurnSpan.parentId).toBe(compactionSpan.spanId);
	});

	it("nests overflow compaction under the ended turn even when willRetry is false (recovery exhausted)", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		const turnSpanId = state.turnSpan!.spanId;

		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "error" },
			toolResults: [],
		});

		// Overflow recovery already attempted once: willRetry=false, so no
		// pendingRetryParent / pendingAttemptReason should be set.
		await pi.fire("session_compact", {
			type: "session_compact",
			compactionEntry: { tokensBefore: 1000, firstKeptEntryId: "entry-5", summary: "..." },
			fromExtension: false,
			reason: "overflow",
			willRetry: false,
		});

		expect(state.pendingRetryParent).toBeUndefined();
		expect(state.pendingAttemptReason).toBeUndefined();

		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const compactionSpan = trace.data.spans.find((s) => s.name === "pi.compaction")!;
		expect(compactionSpan.parentId).toBe(turnSpanId);
		expect(compactionSpan.attributes["pi.compaction.willRetry"]).toBe(false);
	});

	it("nests manual/threshold compaction between turns under the root span", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const rootTraceId = state.rootSpan!.traceId;
		const rootSpanId = state.rootSpan!.spanId;

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });

		await pi.fire("session_compact", {
			type: "session_compact",
			compactionEntry: { tokensBefore: 500, firstKeptEntryId: "entry-2", summary: "..." },
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});

		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		const compactionSpan = trace.data.spans.find((s) => s.name === "pi.compaction")!;
		expect(compactionSpan.parentId).toBe(rootSpanId);
	});

	it("does not trace compaction when no trace is active", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		// No agent_start fired: idle between prompts.
		await pi.fire("session_compact", {
			type: "session_compact",
			compactionEntry: { tokensBefore: 300, firstKeptEntryId: "entry-1", summary: "..." },
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		});

		expect(state.rootSpan).toBeUndefined();
		// Nothing to assert on a trace since none was created — the handler must
		// simply not throw and must not create any span tree.
	});
});

describe("extractAssistantText (root chat summary)", () => {
	it("joins type===text parts and plain strings", () => {
		expect(
			extractAssistantText([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
			]),
		).toBe("Hello world");
		expect(extractAssistantText("  plain string  ")).toBe("plain string");
		expect(extractAssistantText(["a", "b"])).toBe("ab");
	});

	it("skips thinking and toolCall parts", () => {
		expect(
			extractAssistantText([
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "visible" },
				{ type: "toolCall", id: "1", name: "bash", arguments: {} },
			]),
		).toBe("visible");
	});

	it("returns undefined for empty / non-text content", () => {
		expect(extractAssistantText([])).toBeUndefined();
		expect(extractAssistantText("   ")).toBeUndefined();
		expect(extractAssistantText([{ type: "toolCall", id: "1", name: "x", arguments: {} }])).toBeUndefined();
		expect(extractAssistantText(null)).toBeUndefined();
		expect(extractAssistantText(42)).toBeUndefined();
	});
});

describe("root chat turn summary (Sessions bubbles)", () => {
	function assistantMessage(overrides: Record<string, unknown> = {}) {
		return {
			role: "assistant",
			content: [{ type: "text", text: "assistant reply" }],
			provider: "anthropic",
			model: "claude-x",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("publishes string root inputs/outputs when captureContent is true", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "expanded user prompt",
				systemPrompt: "sys",
				systemPromptOptions: {},
			},
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const setInputsSpy = vi.spyOn(root, "setInputs");
		const setOutputsSpy = vi.spyOn(root, "setOutputs");

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", { type: "message_end", message: assistantMessage() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});

		// Snapshot before settled ends the root (InMemoryTraceManager drops on end).
		// Publish runs inside settle — spy setInputs/setOutputs instead of post-end accessors.
		expect(state.pendingUserPrompt).toBe("expanded user prompt");
		expect(state.lastAssistantText).toBe("assistant reply");

		await pi.fire("agent_settled", { type: "agent_settled" });

		expect(setInputsSpy).toHaveBeenCalledWith("expanded user prompt");
		expect(setOutputsSpy).toHaveBeenCalledWith("assistant reply");
		// Pending fields cleared after cycle end so the next cycle does not leak.
		expect(state.pendingUserPrompt).toBeUndefined();
		expect(state.lastAssistantText).toBeUndefined();
		expect(state.lastAssistantError).toBeUndefined();
		expect(state.rootSpan).toBeUndefined();
	});

	it("does not set root summary inputs/outputs when captureContent is false", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(false));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "should not be captured",
				systemPrompt: "sys",
				systemPromptOptions: {},
			},
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const setInputsSpy = vi.spyOn(root, "setInputs");
		const setOutputsSpy = vi.spyOn(root, "setOutputs");
		const rootTraceId = root.traceId;

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({ content: [{ type: "text", text: "secret" }] }),
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});

		const trace = snapshotTraceSpans(rootTraceId);
		await pi.fire("agent_settled", { type: "agent_settled" });

		expect(state.pendingUserPrompt).toBeUndefined();
		expect(state.lastAssistantText).toBeUndefined();
		expect(setInputsSpy).not.toHaveBeenCalled();
		expect(setOutputsSpy).not.toHaveBeenCalled();

		const rootSpan = trace.data.spans.find((s) => s.parentId === null)!;
		expect(rootSpan.inputs).toBeUndefined();
		expect(rootSpan.outputs).toBeUndefined();
	});

	it("keeps earlier assistant text when a later message is tool-only or empty", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "p", systemPrompt: "s", systemPromptOptions: {} },
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const setOutputsSpy = vi.spyOn(root, "setOutputs");

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({ content: [{ type: "text", text: "first prose" }] }),
		});
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }],
			}),
		});
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({ content: [] }),
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});

		expect(state.lastAssistantText).toBe("first prose");
		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(setOutputsSpy).toHaveBeenCalledWith("first prose");
	});

	it("uses structural errorMessage then stopReason when there is no assistant text", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "p", systemPrompt: "s", systemPromptOptions: {} },
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const setOutputsSpy = vi.spyOn(root, "setOutputs");

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({
				content: [],
				stopReason: "error",
				errorMessage: "provider 500",
			}),
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "error" },
			toolResults: [],
		});
		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(setOutputsSpy).toHaveBeenCalledWith("provider 500");

		// Second cycle: no errorMessage → normative stopReason fallback.
		await pi.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "p2", systemPrompt: "s", systemPromptOptions: {} },
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root2 = state.rootSpan!;
		const setOutputsSpy2 = vi.spyOn(root2, "setOutputs");
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({ content: [], stopReason: "aborted" }),
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "aborted" },
			toolResults: [],
		});
		await pi.fire("agent_settled", { type: "agent_settled" });
		expect(setOutputsSpy2).toHaveBeenCalledWith("aborted");
	});

	it("keeps stashed prompt across re-entrant agent_start and publishes on shutdown", async () => {
		const pi = new FakeExtensionAPI();
		const state = createInitialState(makeConfig(true));
		state.enabled = true;
		registerLifecycleHandlers(pi as never, state);

		await pi.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "cycle prompt",
				systemPrompt: "s",
				systemPromptOptions: {},
			},
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		const root = state.rootSpan!;
		const setInputsSpy = vi.spyOn(root, "setInputs");
		const setOutputsSpy = vi.spyOn(root, "setOutputs");

		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("message_end", {
			type: "message_end",
			message: assistantMessage({ content: [{ type: "text", text: "mid" }] }),
		});

		// Re-entrant agent_start (retry/continue) must not clear pending chat fields.
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		expect(state.rootSpan).toBe(root);
		expect(state.pendingUserPrompt).toBe("cycle prompt");
		expect(state.lastAssistantText).toBe("mid");
		expect(state.attemptIndex).toBe(1);

		// Shutdown mid-cycle still publishes while root is open.
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(setInputsSpy).toHaveBeenCalledWith("cycle prompt");
		expect(setOutputsSpy).toHaveBeenCalledWith("mid");
		expect(state.pendingUserPrompt).toBeUndefined();
		expect(state.lastAssistantText).toBeUndefined();
		expect(state.rootSpan).toBeUndefined();

		// Next cycle does not leak prior prompt/text.
		await pi.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "next cycle",
				systemPrompt: "s",
				systemPromptOptions: {},
			},
			makeCtx(),
		);
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx());
		expect(state.pendingUserPrompt).toBe("next cycle");
		expect(state.lastAssistantText).toBeUndefined();
		expect(state.lastAssistantError).toBeUndefined();
		await pi.fire("agent_settled", { type: "agent_settled" });
	});
});
