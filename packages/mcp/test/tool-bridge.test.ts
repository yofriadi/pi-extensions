import { describe, expect, it, vi } from "vitest";
import { createMcpToolBridge } from "../src/tools/mcp-tool-bridge.js";

describe("mcp tool bridge", () => {
	it("gracefully skips unavailable tool lists", () => {
		const registerTool = vi.fn();
		const manager = {
			getState: () => ({
				toolLists: {
					alpha: {
						server: "alpha",
						state: "stale",
						reason: "server unavailable",
						tools: [],
					},
				},
			}),
			callTool: vi.fn(),
		};

		const bridge = createMcpToolBridge(
			{
				registerTool,
			} as never,
			manager as never,
		);

		const result = bridge.sync();
		expect(result.added).toBe(0);
		expect(result.total).toBe(0);
		expect(result.failed).toHaveLength(0);
		expect(registerTool).not.toHaveBeenCalled();
	});

	it("reports registration failures instead of throwing", () => {
		const registerTool = vi.fn((tool: { name: string }) => {
			if (tool.name.includes("unstable")) {
				throw new Error("register failed");
			}
		});
		const manager = {
			getState: () => ({
				toolLists: {
					alpha: {
						server: "alpha",
						state: "ready",
						reason: "ok",
						tools: [
							{ name: "stable_tool", inputSchema: { type: "object" } },
							{ name: "unstable_tool", inputSchema: { type: "object" } },
						],
					},
				},
			}),
			callTool: vi.fn(),
		};

		const bridge = createMcpToolBridge(
			{
				registerTool,
			} as never,
			manager as never,
		);

		const result = bridge.sync();
		expect(result.added).toBe(1);
		expect(result.total).toBe(1);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.key).toBe("alpha::unstable_tool");
	});
});
