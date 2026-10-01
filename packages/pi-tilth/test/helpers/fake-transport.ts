import type { TilthMcpTransport } from "../../src/lib/transport";

export interface FakeTransportCall {
	toolName: string;
	params: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface FakeTransport {
	/** Every `callTool` invocation, in order (scoped params as the transport received them). */
	calls: FakeTransportCall[];
	callTool(toolName: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<string>;
	readonly connected: boolean;
	stop(): Promise<void>;
}

/**
 * Minimal structural stand-in for `TilthMcpTransport` for tool-level unit
 * tests: records calls and returns the handler's text (or throws whatever the
 * handler throws). Use `asTilthTransport` to satisfy `TilthToolDeps`.
 */
export function createFakeTransport(
	handler: (toolName: string, params: Record<string, unknown>) => string | Promise<string>,
): FakeTransport {
	const calls: FakeTransportCall[] = [];
	return {
		calls,
		connected: true,
		async callTool(toolName, params, options) {
			calls.push({ toolName, params, ...(options?.signal !== undefined ? { signal: options.signal } : {}) });
			return handler(toolName, params);
		},
		async stop() {},
	};
}

/** `TilthToolDeps.transport` is the concrete class; a structural fake is sufficient at runtime. */
export function asTilthTransport(fake: FakeTransport): TilthMcpTransport {
	return fake as unknown as TilthMcpTransport;
}
