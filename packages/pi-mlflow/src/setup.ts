import { resolve } from "node:path";
import { trace as otelTrace } from "@opentelemetry/api";
import * as mlflow from "mlflow-tracing";
import { loadConfig, type PiMlflowConfig } from "./config.ts";
import { resolveOrCreateExperiment } from "./experiment.ts";
import type { DisabledReason } from "./state.ts";

/**
 * Outcome of resolving config + experiment + SDK init, deliberately *not*
 * a full `TracingState`: caching live span references (`toolSpans`, etc.)
 * across extension instances would make every instance share the exact same
 * `Map`/span objects, causing tool-span cross-talk if `piMlflow()`'s factory
 * ever runs more than once in a process (e.g. multiple loaded extension
 * copies). Only this plain, side-effect-free data is safe to share.
 *
 * The whole result (including `config`) is cached for the process lifetime
 * per D8 / OTel singleton constraints: a later `/reload` that re-runs the
 * factory will reuse this cache for the same cwd and will *not* re-read
 * `pi-mlflow.json` or re-init the SDK against a new tracking server.
 * Changing config requires restarting the pi process.
 */
export interface SetupResult {
	config: PiMlflowConfig;
	enabled: boolean;
	disabledReason?: DisabledReason;
	experimentId?: string;
}

/**
 * Process-global cache key. Symbol.for lets multiple evaluations/copies of
 * this extension in the same process share the same cache without colliding
 * with arbitrary string properties on globalThis.
 */
const GLOBAL_CACHE_KEY = Symbol.for("pi-mlflow.setup-cache.v1");

interface SetupCacheEntry {
	cwd: string;
	promise: Promise<SetupResult>;
}

interface GlobalWithCache {
	[key: symbol]: SetupCacheEntry | undefined;
}

/** Test-only escape hatch to force re-resolution in a fresh test case. */
export function resetSetupCacheForTests(): void {
	delete (globalThis as GlobalWithCache)[GLOBAL_CACHE_KEY];
}

/**
 * Load config, resolve-or-create the experiment, and initialize the MLflow
 * tracing SDK. On any failure, returns a disabled result with a reason
 * instead of throwing — per D9, an unreachable server disables tracing
 * silently (one log line, no retry, no interactive warning), it does not
 * crash pi.
 *
 * Auth for experiment REST uses the same `MLFLOW_TRACKING_*` env contract as
 * the SDK (see `src/auth.ts` / `src/experiment.ts`). Experiment resolve runs
 * before `mlflow.init()` because init requires a numeric experimentId, but
 * both paths share the same credential resolution so auth-protected servers
 * work end-to-end.
 */
export async function setupTracing(cwd: string, log: (message: string) => void): Promise<SetupResult> {
	const cache = globalThis as GlobalWithCache;
	const normalizedCwd = resolve(cwd);
	const cached = cache[GLOBAL_CACHE_KEY];
	if (cached) {
		if (cached.cwd === normalizedCwd) {
			return cached.promise;
		}
		// A pi process should normally be scoped to one project. If a reload or
		// session replacement changes cwd, never reuse project A's config/experiment
		// for project B, and never attempt a second OTel SDK registration (the SDK
		// cannot safely replace its global provider). Disable this instance instead.
		return {
			config: { trackingUri: "", experimentName: "", captureContent: false },
			enabled: false,
			disabledReason: `tracing setup already initialized for another project in this process (${cached.cwd})`,
		};
	}

	// Install the cache entry *before* any async setup work so a second caller
	// that races the first init (e.g. two extension instances starting in the
	// same tick) always joins the same in-flight promise instead of both
	// missing an empty cache, both calling mlflow.init, and the slower one
	// overwriting a successful result with a disabled one.
	let resolveSetup!: (result: SetupResult) => void;
	const setupPromise = new Promise<SetupResult>((resolve) => {
		resolveSetup = resolve;
	});
	cache[GLOBAL_CACHE_KEY] = { cwd: normalizedCwd, promise: setupPromise };

	void doSetupTracing(normalizedCwd, log).then(resolveSetup, (error: unknown) => {
		// doSetupTracing is written to never reject, but keep the cache coherent
		// if that invariant ever breaks.
		const reason = `tracking server unreachable or misconfigured at startup (${(error as Error).message})`;
		log(`pi-mlflow: tracing disabled — ${reason}`);
		resolveSetup({
			config: { trackingUri: "", experimentName: "", captureContent: false },
			enabled: false,
			disabledReason: reason,
		});
	});

	return setupPromise;
}

async function doSetupTracing(cwd: string, log: (message: string) => void): Promise<SetupResult> {
	let config: PiMlflowConfig | undefined;

	try {
		config = await loadConfig(cwd);

		// Auth headers for this REST call come from MLFLOW_TRACKING_* env (same
		// contract as mlflow.init). Init still needs experimentId, so resolve
		// first; both paths share credential resolution so protected servers work.
		const experimentId = await resolveOrCreateExperiment(config.trackingUri, config.experimentName);
		initMlflowOrThrow({ trackingUri: config.trackingUri, experimentId });

		return { config, enabled: true, experimentId };
	} catch (error) {
		const reason = `tracking server unreachable or misconfigured at startup (${(error as Error).message})`;
		log(`pi-mlflow: tracing disabled — ${reason}`);

		// config may not have loaded; fall back to a result that still carries
		// whatever default-shaped config we can, so /mlflow has something to show.
		return {
			config: config ?? { trackingUri: "", experimentName: "", captureContent: false },
			enabled: false,
			disabledReason: reason,
		};
	}
}

/**
 * `mlflow.init()` validates its arguments synchronously (throws on a missing
 * or malformed `trackingUri`/`experimentId`), but that does not guarantee the
 * SDK is actually usable afterward. Two independent failure modes exist that
 * `mlflow.init()` itself never surfaces as a thrown error:
 *
 * 1. The SDK-initialization step it triggers internally (`initializeSDK` in
 *    `mlflow-tracing`) catches its own errors and only `console.error`s
 *    them — it never rethrows.
 * 2. `NodeSDK.start()` registers a global OpenTelemetry tracer provider via
 *    `@opentelemetry/api`'s `registerGlobal()`, which *silently* returns
 *    `false` (only a diag-level log, not an exception) if a different
 *    tracer provider is already globally registered — e.g. by another pi
 *    extension using OTel directly. When that happens `mlflow.startSpan()`
 *    would silently produce a `NoOpSpan` and nothing would ever be exported.
 *
 * Left unchecked, either failure mode would make this extension mark itself
 * `enabled: true` (and `/mlflow` report "active") while producing no usable
 * traces at all. Rather than creating a real probe span (which would export
 * an extra, meaningless trace to the user's server on every startup), this
 * checks whether `@opentelemetry/api`'s global `ProxyTracerProvider`
 * delegate actually changed to a new provider instance as a result of this
 * `init()` call — which is exactly the signal `registerGlobal()`'s silent
 * `false` return means "no". Confirmed against the installed
 * `@opentelemetry/api`/`sdk-trace-node`/`mlflow-tracing` versions: a
 * successful `init()` swaps the delegate to a new `NodeTracerProvider`; a
 * blocked one (another provider already registered) leaves the delegate
 * completely unchanged. Any failure here is folded into the same
 * silent-disable path as every other setup failure (D9).
 */
function initMlflowOrThrow(config: Parameters<typeof mlflow.init>[0]): void {
	const delegateBefore = getRegisteredTracerProviderDelegate();
	mlflow.init(config);
	const delegateAfter = getRegisteredTracerProviderDelegate();

	if (delegateBefore === delegateAfter) {
		throw new Error(
			"mlflow.init() completed but the global OpenTelemetry tracer provider was not updated — likely another OpenTelemetry tracer provider is already globally registered in this process (e.g. by another extension), or the MLflow SDK failed to initialize internally (see console output above)",
		);
	}
}

/**
 * The underlying delegate of `@opentelemetry/api`'s global `ProxyTracerProvider`.
 * `getDelegate()` exists on `ProxyTracerProvider` specifically (not on the
 * `TracerProvider` interface in general), hence the narrow cast — this is the
 * same provider type `@opentelemetry/api` always installs as the global.
 */
function getRegisteredTracerProviderDelegate(): unknown {
	const provider = otelTrace.getTracerProvider() as { getDelegate?: () => unknown };
	return provider.getDelegate?.() ?? provider;
}
