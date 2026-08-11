// Shared mutable state for the extension. This module intentionally imports no
// local modules so feature clusters can depend on it without creating a cycle.

export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagent-herdr/runtime");
export const DELIVERY_RETRY_INTERVAL_KEY = Symbol.for("pi-subagent-herdr/delivery-retry-interval");

const globals = globalThis as any;
export const runtime =
	globals[RUNTIME_KEY] ??
	(globals[RUNTIME_KEY] = {
		runningSubagents: new Map<string, any>(),
		queuedSubagents: new Map<string, any>(),
		pendingDeliveries: new Map<string, any>(),
		stickyTerminalRuns: new Map<string, any>(),
		deliveredRunIds: new Set<string>(),
		parentActivity: { streaming: false, turnStartedAtMs: 0 },
	});

// Hydrate fields introduced after an older extension module initialized the
// global runtime. The objects below are intentionally exported by reference.
runtime.runningSubagents ??= new Map<string, any>();
runtime.queuedSubagents ??= new Map<string, any>();
runtime.pendingDeliveries ??= new Map<string, any>();
runtime.stickyTerminalRuns ??= new Map<string, any>();
runtime.deliveredRunIds ??= new Set<string>();
runtime.parentActivity ??= { streaming: false, turnStartedAtMs: 0 };

export const runningSubagents = runtime.runningSubagents as Map<string, any>;
export const queuedSubagents = runtime.queuedSubagents as Map<string, any>;
export const pendingDeliveries = runtime.pendingDeliveries as Map<string, any>;
export const stickyTerminalRuns = runtime.stickyTerminalRuns as Map<string, any>;
export const deliveredRunIds = runtime.deliveredRunIds as Set<string>;

/** In-flight acknowledgement promises are intentionally not reload-persistent. */
export const inflightDelivery = new Map<string, Promise<void>>();
/** Parent sessions with a wake nudge that has not yet been consumed. */
export const wakeInflightByParent = new Set<string>();
