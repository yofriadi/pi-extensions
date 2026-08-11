/**
 * Real MLflow Tracking Server verification (tasks 6.1–6.7).
 *
 * Requires a running server configured for the TS SDK's artifact client:
 *
 *   mlflow server \
 *     --host 127.0.0.1 --port 5055 \
 *     --backend-store-uri sqlite:///$HOME/.mlflow-server/mlruns.db \
 *     --serve-artifacts \
 *     --artifacts-destination $HOME/.mlflow-server/mlartifacts
 *
 * Override with MLFLOW_TEST_TRACKING_URI. When the server is unreachable the
 * suite is skipped so ordinary `npm test` stays offline-friendly; run
 * `npm run test:integration` (or start the server first) to exercise these.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace as otelTrace } from "@opentelemetry/api";
import * as mlflow from "mlflow-tracing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiMlflowConfig } from "../src/config.ts";
import { registerLifecycleHandlers } from "../src/lifecycle.ts";
import { resetSetupCacheForTests, setupTracing } from "../src/setup.ts";
import { createInitialState } from "../src/state.ts";
import { buildStatusLines } from "../src/status-command.ts";

const TRACKING_URI = process.env.MLFLOW_TEST_TRACKING_URI ?? "http://127.0.0.1:5055";
const EXPERIMENT_NAME = `pi-integration-${Date.now()}`;

class FakeExtensionAPI {
	private handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	private commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(
		name: string,
		def: { description?: string; handler: (args: string, ctx: unknown) => unknown },
	): void {
		this.commands.set(name, def);
	}

	async fire(event: string, payload: unknown, ctx: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async runCommand(name: string, args = "", ctx: unknown = {}): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`command not registered: ${name}`);
		await command.handler(args, ctx);
	}
}

function makeCtx(sessionId = "session-integration") {
	return {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => sessionId },
		thinkingLevel: undefined as string | undefined,
	};
}

interface ExportedSpan {
	name: string;
	parent_span_id?: string;
	span_id: string;
	status?: { code?: string };
	attributes?: Record<string, unknown>;
}

interface ExportedTraceData {
	spans: ExportedSpan[];
}

interface TraceInfoResponse {
	trace?: {
		trace_info?: {
			trace_id?: string;
			state?: string;
			tags?: Record<string, string>;
			trace_metadata?: Record<string, string>;
		};
	};
}

async function serverReachable(uri: string): Promise<boolean> {
	try {
		const response = await fetch(`${uri.replace(/\/+$/, "")}/health`, {
			signal: AbortSignal.timeout(1_500),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForTraceData(traceId: string, timeoutMs = 10_000): Promise<ExportedTraceData> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const infoRes = await fetch(`${TRACKING_URI.replace(/\/+$/, "")}/api/3.0/mlflow/traces/${traceId}`);
			if (!infoRes.ok) {
				throw new Error(`get trace info HTTP ${infoRes.status}`);
			}
			const info = (await infoRes.json()) as TraceInfoResponse;
			const artifactUri = info.trace?.trace_info?.tags?.["mlflow.artifactLocation"];
			if (!artifactUri) {
				throw new Error("missing mlflow.artifactLocation tag");
			}
			const pathname = new URL(artifactUri).pathname;
			const artRes = await fetch(
				`${TRACKING_URI.replace(/\/+$/, "")}/api/2.0/mlflow-artifacts/artifacts${pathname}/traces.json`,
			);
			if (!artRes.ok) {
				throw new Error(`artifact HTTP ${artRes.status}`);
			}
			return (await artRes.json()) as ExportedTraceData;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error(`trace data not available for ${traceId}: ${String(lastError)}`);
}

async function waitForTraceInfo(
	traceId: string,
	timeoutMs = 10_000,
): Promise<NonNullable<TraceInfoResponse["trace"]>["trace_info"]> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const infoRes = await fetch(`${TRACKING_URI.replace(/\/+$/, "")}/api/3.0/mlflow/traces/${traceId}`);
			if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
			const info = (await infoRes.json()) as TraceInfoResponse;
			if (info.trace?.trace_info?.trace_id) return info.trace.trace_info;
			throw new Error("missing trace_info");
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error(`trace info not available for ${traceId}: ${String(lastError)}`);
}

function spanByName(data: ExportedTraceData, name: string): ExportedSpan {
	const span = data.spans.find((s) => s.name === name);
	if (!span) throw new Error(`span not found: ${name} (have ${data.spans.map((s) => s.name).join(",")})`);
	return span;
}

const reachable = await serverReachable(TRACKING_URI);

describe.runIf(reachable)("real MLflow server verification (tasks 6.1–6.7)", () => {
	let experimentId: string;
	let config: PiMlflowConfig;

	beforeAll(async () => {
		// Unit suites may have registered a competing/no-op provider; clear it so
		// this file can init against the real tracking server.
		otelTrace.disable();
		resetSetupCacheForTests();

		const createRes = await fetch(`${TRACKING_URI.replace(/\/+$/, "")}/api/2.0/mlflow/experiments/create`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: EXPERIMENT_NAME }),
		});
		if (!createRes.ok) {
			throw new Error(`failed to create experiment: HTTP ${createRes.status} ${await createRes.text()}`);
		}
		const created = (await createRes.json()) as { experiment_id?: string };
		if (!created.experiment_id) throw new Error("create experiment missing id");
		experimentId = created.experiment_id;

		config = {
			trackingUri: TRACKING_URI,
			experimentName: EXPERIMENT_NAME,
			captureContent: false,
		};
		mlflow.init({ trackingUri: TRACKING_URI, experimentId });
	}, 30_000);

	afterAll(() => {
		otelTrace.disable();
		resetSetupCacheForTests();
	});

	function enabledState(captureContent = false) {
		const state = createInitialState({ ...config, captureContent });
		state.enabled = true;
		state.experimentId = experimentId;
		return state;
	}

	it("6.1 exports one turn-cycle with sequential tool spans under the root", async () => {
		const pi = new FakeExtensionAPI();
		const state = enabledState(false);
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-1"));
		const traceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: "aaa",
			isError: false,
		});
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "grep",
			args: { pattern: "foo" },
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "grep",
			result: "match",
			isError: false,
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [{}, {}],
		});
		await pi.fire("agent_settled", { type: "agent_settled" });

		const data = await waitForTraceData(traceId);
		const root = spanByName(data, "pi.agent");
		const turn = spanByName(data, "pi.turn");
		const read = spanByName(data, "read");
		const grep = spanByName(data, "grep");
		expect(turn.parent_span_id).toBe(root.span_id);
		expect(read.parent_span_id).toBe(turn.span_id);
		expect(grep.parent_span_id).toBe(turn.span_id);
		expect(root.status?.code).toBe("STATUS_CODE_OK");

		const info = await waitForTraceInfo(traceId);
		expect(info?.trace_metadata?.["mlflow.trace.session"]).toBe("session-6-1");
	}, 20_000);

	it("6.2 exports parallel tool spans closed with their own results out of start order", async () => {
		const pi = new FakeExtensionAPI();
		const state = enabledState(true);
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-2"));
		const traceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "first",
			toolName: "read-a",
			args: { path: "a" },
		});
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "second",
			toolName: "read-b",
			args: { path: "b" },
		});
		// Finish second before first.
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "second",
			toolName: "read-b",
			result: "contents-b",
			isError: false,
		});
		await pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "first",
			toolName: "read-a",
			result: "contents-a",
			isError: false,
		});
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [{}, {}],
		});
		await pi.fire("agent_settled", { type: "agent_settled" });

		const data = await waitForTraceData(traceId);
		const a = spanByName(data, "read-a");
		const b = spanByName(data, "read-b");
		expect(a.attributes?.["mlflow.spanOutputs"]).toBe("contents-a");
		expect(b.attributes?.["mlflow.spanOutputs"]).toBe("contents-b");
		expect(a.status?.code).toBe("STATUS_CODE_OK");
		expect(b.status?.code).toBe("STATUS_CODE_OK");
	}, 20_000);

	it("6.3 nests overflow compaction under the ended turn and keeps the retry as a descendant", async () => {
		const pi = new FakeExtensionAPI();
		const state = enabledState(false);
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-3"));
		const traceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "aborted" },
			toolResults: [],
		});
		await pi.fire("session_compact", {
			type: "session_compact",
			reason: "overflow",
			willRetry: true,
			compactionEntry: { tokensBefore: 12_000, firstKeptEntryId: "e1" },
		});
		// post-compaction continue: another agent_start + turn under compaction
		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-3"));
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		await pi.fire("before_provider_request", { payload: { messages: [] } }, makeCtx("session-6-3"));
		await pi.fire(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					provider: "test",
					model: "test-model",
					content: "ok",
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			},
			makeCtx("session-6-3"),
		);
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		await pi.fire("agent_settled", { type: "agent_settled" });

		const data = await waitForTraceData(traceId);
		const root = spanByName(data, "pi.agent");
		// Exporter disambiguates duplicate names as pi.turn_1 / pi.turn_2.
		const turns = data.spans.filter((s) => s.name === "pi.turn" || s.name.startsWith("pi.turn_"));
		expect(turns.length).toBe(2);
		const firstTurn = turns[0]!;
		const compact = spanByName(data, "pi.compaction");
		expect(compact.parent_span_id).toBe(firstTurn.span_id);
		const retryTurn = turns[1]!;
		expect(retryTurn.parent_span_id).toBe(compact.span_id);
		expect(firstTurn.parent_span_id).toBe(root.span_id);
		const llm = spanByName(data, "pi.llm");
		expect(llm.parent_span_id).toBe(retryTurn.span_id);
		expect(llm.attributes?.["pi.attempt.reason"]).toBe("post_compaction");
	}, 20_000);

	it("6.4 nests manual compaction between turns under the root span", async () => {
		const pi = new FakeExtensionAPI();
		const state = enabledState(false);
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-4"));
		const traceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		});
		await pi.fire("session_compact", {
			type: "session_compact",
			reason: "manual",
			willRetry: false,
			compactionEntry: { tokensBefore: 800, firstKeptEntryId: "e2" },
		});
		await pi.fire("agent_settled", { type: "agent_settled" });

		const data = await waitForTraceData(traceId);
		const root = spanByName(data, "pi.agent");
		const compact = spanByName(data, "pi.compaction");
		expect(compact.parent_span_id).toBe(root.span_id);
		expect(compact.attributes?.["pi.compaction.reason"]).toBe("manual");
	}, 20_000);

	it("6.5 silently disables when the tracking server is unreachable and /mlflow reports the reason", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mlflow-down-"));
		try {
			await writeFile(
				join(dir, "pi-mlflow.json"),
				JSON.stringify({
					trackingUri: "http://127.0.0.1:1",
					experimentName: "should-fail",
					captureContent: false,
				}),
			);
			// Isolate from the live-server init used by other cases in this file.
			otelTrace.disable();
			resetSetupCacheForTests();
			const logged: string[] = [];
			const result = await setupTracing(dir, (message) => logged.push(message));
			expect(result.enabled).toBe(false);
			expect(result.disabledReason).toMatch(/unreachable|misconfigured|ECONNREFUSED|timed out|fetch failed/i);
			expect(logged).toHaveLength(1);
			expect(logged[0]).toMatch(/^pi-mlflow: tracing disabled/);

			const lines = buildStatusLines({
				config: result.config,
				enabled: result.enabled,
				disabledReason: result.disabledReason,
				toolSpans: new Map(),
				turnCounter: 0,
				attemptIndex: 0,
				finalCycleStatus: mlflow.SpanStatusCode.OK,
			});
			expect(lines.join("\n")).toMatch(/status: disabled/);
			expect(lines.join("\n")).not.toMatch(/status: active/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			// Re-arm live server init for any later cases.
			otelTrace.disable();
			resetSetupCacheForTests();
			mlflow.init({ trackingUri: TRACKING_URI, experimentId });
		}
	}, 20_000);

	it("6.6 force-closes open spans on session_shutdown and flushes the incomplete cycle", async () => {
		const pi = new FakeExtensionAPI();
		const state = enabledState(false);
		registerLifecycleHandlers(pi as never, state);

		await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-6"));
		const traceId = state.rootSpan!.traceId;
		await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await pi.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "orphan",
			toolName: "bash",
			args: { command: "sleep 999" },
		});
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "interrupt" });

		expect(state.rootSpan).toBeUndefined();
		expect(state.toolSpans.size).toBe(0);

		const data = await waitForTraceData(traceId);
		const root = spanByName(data, "pi.agent");
		const turn = spanByName(data, "pi.turn");
		const tool = spanByName(data, "bash");
		expect(tool.status?.code).toBe("STATUS_CODE_ERROR");
		expect(turn.status?.code).toBe("STATUS_CODE_ERROR");
		expect(root.status?.code).toBe("STATUS_CODE_ERROR");
		expect(tool.attributes?.["pi.span.incomplete"]).toBe(true);
	}, 20_000);

	it("6.7 omits content when captureContent is false and includes it when true", async () => {
		// false
		{
			const pi = new FakeExtensionAPI();
			const state = enabledState(false);
			registerLifecycleHandlers(pi as never, state);
			await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-7-off"));
			const traceId = state.rootSpan!.traceId;
			await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
			await pi.fire("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "read",
				args: { path: "/secret" },
			});
			await pi.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "read",
				result: "TOP_SECRET",
				isError: false,
			});
			await pi.fire("before_provider_request", { payload: { prompt: "hide me" } }, makeCtx());
			await pi.fire("message_end", {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					provider: "test",
					model: "m",
					content: "visible-response?",
					usage: { input: 3, output: 4, totalTokens: 7, cost: { input: 0.1, output: 0.2, total: 0.3 } },
				},
			});
			await pi.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", stopReason: "stop" },
				toolResults: [{}],
			});
			await pi.fire("agent_settled", { type: "agent_settled" });

			const data = await waitForTraceData(traceId);
			const tool = spanByName(data, "read");
			const llm = spanByName(data, "pi.llm");
			expect(tool.attributes?.["mlflow.spanInputs"]).toBeUndefined();
			expect(tool.attributes?.["mlflow.spanOutputs"]).toBeUndefined();
			expect(llm.attributes?.["mlflow.spanInputs"]).toBeUndefined();
			expect(llm.attributes?.["mlflow.spanOutputs"]).toBeUndefined();
			// structural metadata still present
			expect(llm.attributes?.["mlflow.chat.tokenUsage"]).toEqual({
				input_tokens: 3,
				output_tokens: 4,
				total_tokens: 7,
			});
		}

		// true
		{
			const pi = new FakeExtensionAPI();
			const state = enabledState(true);
			registerLifecycleHandlers(pi as never, state);
			await pi.fire("agent_start", { type: "agent_start" }, makeCtx("session-6-7-on"));
			const traceId = state.rootSpan!.traceId;
			await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
			await pi.fire("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "c2",
				toolName: "read",
				args: { path: "/secret" },
			});
			await pi.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "c2",
				toolName: "read",
				result: "TOP_SECRET",
				isError: false,
			});
			await pi.fire("before_provider_request", { payload: { prompt: "show me" } }, makeCtx());
			await pi.fire("message_end", {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					provider: "test",
					model: "m",
					content: "assistant-text",
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			});
			await pi.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", stopReason: "stop" },
				toolResults: [{}],
			});
			await pi.fire("agent_settled", { type: "agent_settled" });

			const data = await waitForTraceData(traceId);
			const tool = spanByName(data, "read");
			const llm = spanByName(data, "pi.llm");
			expect(tool.attributes?.["mlflow.spanInputs"]).toEqual({ path: "/secret" });
			expect(tool.attributes?.["mlflow.spanOutputs"]).toBe("TOP_SECRET");
			expect(llm.attributes?.["mlflow.spanInputs"]).toEqual({ prompt: "show me" });
			expect(llm.attributes?.["mlflow.spanOutputs"]).toBe("assistant-text");
		}
	}, 40_000);
});

describe.runIf(!reachable)("real MLflow server verification (skipped — server not running)", () => {
	it(`skips tasks 6.1–6.7 because ${TRACKING_URI} is unreachable`, () => {
		// Present so `npm test` documents the skip rather than silently omitting the file.
		expect(reachable).toBe(false);
	});
});
