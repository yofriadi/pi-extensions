import { describe, expect, it } from "vitest";
import { createLspRuntimeRegistry } from "../src/client/registry.js";
import type { LspClientRuntime, LspRuntimeStatus } from "../src/client/runtime.js";
import type { ResolvedLspConfig } from "../src/config/resolver.js";

class FakeRuntime implements LspClientRuntime {
	requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
	status: LspRuntimeStatus = {
		state: "inactive",
		reason: "not started",
		configuredCommand: undefined,
		activeCommand: undefined,
		transport: undefined,
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: undefined,
		diagnosticsCount: 0,
	};

	async start(configuredCommand: string[] | undefined): Promise<void> {
		this.status = {
			...this.status,
			state: configuredCommand && configuredCommand.length > 0 ? "ready" : "inactive",
			reason: configuredCommand && configuredCommand.length > 0 ? "ready" : "not configured",
			configuredCommand,
			activeCommand: configuredCommand,
			transport: "direct",
			pid: 100,
		};
	}

	async stop(): Promise<void> {
		this.status = {
			...this.status,
			state: "inactive",
			reason: "stopped",
			activeCommand: undefined,
			pid: undefined,
		};
	}

	async reload(configuredCommand: string[] | undefined): Promise<void> {
		await this.start(configuredCommand);
	}

	async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		this.requests.push({ method, params, timeoutMs });
		return { method };
	}

	getPublishedDiagnostics(): [] {
		return [];
	}

	getStatus(): LspRuntimeStatus {
		return { ...this.status };
	}
}

class FailingRuntime extends FakeRuntime {
	async start(configuredCommand: string[] | undefined): Promise<void> {
		this.status = {
			...this.status,
			state: "error",
			reason: "failed to start",
			configuredCommand,
			activeCommand: configuredCommand,
			transport: "direct",
			pid: undefined,
		};
	}
}

function config(): ResolvedLspConfig {
	return {
		serverCommand: ["/usr/bin/default"],
		servers: [
			{
				name: "ts",
				command: ["/usr/bin/ts"],
				fileTypes: [".ts", ".tsx"],
			},
			{
				name: "py",
				command: ["/usr/bin/py"],
				fileTypes: [".py"],
			},
			{
				name: "fallback",
				command: ["/usr/bin/fallback"],
			},
		],
	};
}

describe("lsp runtime registry", () => {
	it("routes file-scoped requests by file type with fallback", async () => {
		const tsRuntime = new FakeRuntime();
		const pyRuntime = new FakeRuntime();
		const fallbackRuntime = new FakeRuntime();
		const queue = [tsRuntime, pyRuntime, fallbackRuntime];

		const registry = createLspRuntimeRegistry({
			createRuntime: () => {
				const next = queue.shift();
				if (!next) {
					throw new Error("Unexpected runtime allocation");
				}
				return next;
			},
		});

		await registry.start(config());
		await registry.request("textDocument/hover", { token: "ts" }, { path: "src/main.ts" });
		await registry.request("textDocument/hover", { token: "py" }, { path: "src/main.py" });
		await registry.request("textDocument/hover", { token: "md" }, { path: "README.md" });

		expect(tsRuntime.requests).toHaveLength(1);
		expect(pyRuntime.requests).toHaveLength(1);
		expect(fallbackRuntime.requests).toHaveLength(1);

		const status = registry.getStatus();
		expect(status.state).toBe("ready");
		expect(status.configuredServers).toBe(3);
		expect(status.activeServers).toBe(3);

		expect(registry.getStatusForPath("src/main.ts")?.activeCommand).toEqual(["/usr/bin/ts"]);
		expect(registry.getStatusForPath("src/main.py")?.activeCommand).toEqual(["/usr/bin/py"]);
		expect(registry.getStatusForPath("README.md")?.activeCommand).toEqual(["/usr/bin/fallback"]);

		await registry.stop();
	});

	it("uses first ready server for workspace-scoped requests", async () => {
		const tsRuntime = new FailingRuntime();
		const pyRuntime = new FakeRuntime();
		const fallbackRuntime = new FakeRuntime();
		const queue = [tsRuntime, pyRuntime, fallbackRuntime];

		const registry = createLspRuntimeRegistry({
			createRuntime: () => {
				const next = queue.shift();
				if (!next) {
					throw new Error("Unexpected runtime allocation");
				}
				return next;
			},
		});

		await registry.start(config());
		await registry.request("workspace/symbol", { query: "x" });

		expect(tsRuntime.requests).toHaveLength(0);
		expect(pyRuntime.requests).toHaveLength(1);
		expect(fallbackRuntime.requests).toHaveLength(0);

		const status = registry.getStatus();
		expect(status.state).toBe("ready");
		expect(status.activeServers).toBe(2);

		await registry.stop();
	});
});
