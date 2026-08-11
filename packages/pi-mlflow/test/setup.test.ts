import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace as otelTrace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSetupCacheForTests, setupTracing } from "../src/setup.ts";

describe("setupTracing", () => {
	let dir: string;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-mlflow-setup-"));
		resetSetupCacheForTests();
		fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ experiment: { experiment_id: "7" } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		// Each test may call setupTracing() -> mlflow.init(), which registers a
		// global OpenTelemetry tracer provider. Unregister it so the next test
		// (which reproduces "first init() in a fresh process") isn't blocked by
		// this one's leftover provider — mirrors what actually happens between
		// separate pi process invocations.
		otelTrace.disable();
		await rm(dir, { recursive: true, force: true });
	});

	it("resolves the experiment id only once per process, even across repeated calls", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "repeat-me" }));

		const first = await setupTracing(dir, () => {});
		const second = await setupTracing(dir, () => {});

		expect(first.enabled).toBe(true);
		expect(first.experimentId).toBe("7");
		expect(second).toBe(first);
		// Only the get-by-name lookup should have happened, and only once —
		// not once per setupTracing() call (task 6.8 / "experiment ID is cached").
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("disables tracing silently and logs once when the server is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
		const logged: string[] = [];

		const state = await setupTracing(dir, (message) => logged.push(message));

		expect(state.enabled).toBe(false);
		expect(state.disabledReason).toMatch(/unreachable/);
		expect(logged).toHaveLength(1);
	});

	it("disables tracing when another OpenTelemetry tracer provider already occupies the global slot", async () => {
		// Reproduces the scenario where another pi extension (or anything else in
		// the process) has already called `NodeTracerProvider.register()` before
		// this extension's `mlflow.init()` runs. `registerGlobal()` in
		// `@opentelemetry/api` silently returns `false` in that case (only a
		// diag-level log, never a thrown error), so without this extension's own
		// post-init verification, `mlflow.init()` would appear to succeed while
		// `mlflow.startSpan()` silently produces unusable no-op spans afterward.
		const competingProvider = new NodeTracerProvider({});
		competingProvider.register();
		try {
			await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "collides" }));
			const logged: string[] = [];

			const state = await setupTracing(dir, (message) => logged.push(message));

			expect(state.enabled).toBe(false);
			expect(state.disabledReason).toMatch(/tracer provider/);
			expect(logged).toHaveLength(1);
		} finally {
			otelTrace.disable();
		}
	});

	it("survives module re-evaluation within the same process (simulating extension reload/session replacement)", async () => {
		// vitest's module registry (not jiti's, which is what pi actually uses to
		// reload extensions) is reset here to force a genuinely distinct module
		// instance with its own top-level `let` bindings — the scenario a real
		// /reload or session replacement produces. Only a true process-global
		// (globalThis-backed) cache, not a module-level one, survives this.
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "reload-me" }));

		const first = await setupTracing(dir, () => {});

		vi.resetModules();
		const reloaded = await import(/* @vite-ignore */ "../src/setup.ts");
		const second = await reloaded.setupTracing(dir, () => {});

		expect(second).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent first-time setups so both callers share one init", async () => {
		await writeFile(join(dir, "pi-mlflow.json"), JSON.stringify({ experimentName: "race-me" }));

		// Hold the first fetch open so two setupTracing calls both observe an
		// empty cache before either finishes — the synchronous claim lock must
		// make the second join the first's in-flight promise.
		let releaseFetch!: (value: Response) => void;
		const fetchGate = new Promise<Response>((resolve) => {
			releaseFetch = resolve;
		});
		fetchMock.mockImplementationOnce(() => fetchGate);

		const firstPromise = setupTracing(dir, () => {});
		// Yield so first call installs the cache entry before the second starts.
		await Promise.resolve();
		const secondPromise = setupTracing(dir, () => {});

		releaseFetch(new Response(JSON.stringify({ experiment: { experiment_id: "9" } }), { status: 200 }));

		const [first, second] = await Promise.all([firstPromise, secondPromise]);
		expect(first.enabled).toBe(true);
		expect(first.experimentId).toBe("9");
		expect(second).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
