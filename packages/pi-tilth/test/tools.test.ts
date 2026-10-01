import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAvailabilityState } from "../src/lib/availability";
import { ServerToolError, TransportError } from "../src/lib/result";
import { runTilthCall, type TilthToolDeps } from "../src/toolkit";
import { asTilthTransport, createFakeTransport, type FakeTransport } from "./helpers/fake-transport";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

interface FixtureTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const fixtureTools: FixtureTool[] = (
	JSON.parse(readFileSync(join(packageRoot, "test", "fixtures", "tilth-server-schema.json"), "utf-8")) as {
		tools: FixtureTool[];
	}
).tools;

/** Collect registered tool definitions through the real loader. */
async function loadRegisteredTools(): Promise<
	Map<string, { description: string; label?: string; parameters?: unknown }>
> {
	const agentDir = join(packageRoot, "test", ".tmp-agent");
	const result = await discoverAndLoadExtensions([packageRoot], packageRoot, agentDir);
	expect(result.errors).toEqual([]);
	const extension = result.extensions.find((ext) => ext.path === join(packageRoot, "src", "index.ts"));
	expect(extension).toBeDefined();
	const toolsMap = extension?.tools as unknown as Map<
		string,
		{ definition: { description: string; label?: string; parameters?: unknown } }
	>;
	const unwrapped = new Map<string, { description: string; label?: string; parameters?: unknown }>();
	for (const [name, entry] of toolsMap ??
		(new Map() as Map<string, { definition: { description: string; label?: string; parameters?: unknown } }>)) {
		unwrapped.set(name, entry.definition);
	}
	return unwrapped;
}

describe("tools — verbatim server schema fidelity", () => {
	it("every server tool (except tilth_savings) is registered with its verbatim description", async () => {
		const tools = await loadRegisteredTools();
		for (const serverTool of fixtureTools) {
			if (serverTool.name === "tilth_savings") continue; // command-only by design
			const registered = tools.get(serverTool.name);
			expect(registered, `${serverTool.name} registered`).toBeDefined();
			expect(registered?.description).toBe(serverTool.description);
		}
	});

	it("registers no tool the server does not expose", async () => {
		const tools = await loadRegisteredTools();
		const expected = new Set(fixtureTools.filter((t) => t.name !== "tilth_savings").map((t) => t.name));
		for (const name of tools.keys()) {
			expect(expected.has(name), `unexpected tool ${name}`).toBe(true);
		}
	});

	it("tool labels present for TUI rendering", async () => {
		const tools = await loadRegisteredTools();
		expect(tools.get("tilth_search")?.label).toBe("Tilth Search");
		expect(tools.get("tilth_read")?.label).toBe("Tilth Read");
	});
});

function makeDeps(
	handler: (toolName: string, params: Record<string, unknown>) => string | Promise<string> = () => "ok",
): { deps: TilthToolDeps; transport: FakeTransport } {
	const transport = createFakeTransport(handler);
	const deps: TilthToolDeps = {
		transport: asTilthTransport(transport),
		availability: createAvailabilityState(),
		config: { callTimeoutMs: 60_000, hashlineCompat: false },
		compat: null,
	};
	return { deps, transport };
}

describe("runTilthCall — transport integration", () => {
	it("throws the static unavailable error without calling the transport", async () => {
		const { deps, transport } = makeDeps(() => {
			throw new Error("must not call");
		});
		deps.availability.mode = "unavailable";
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_search",
				params: { query: "x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow(/tilth is not available/);
		expect(transport.calls).toHaveLength(0);
	});

	it("issues exactly one transport call and returns the joined text", async () => {
		const { deps, transport } = makeDeps(() => "result text");
		deps.availability.mode = "binary";
		const result = await runTilthCall({
			deps,
			toolName: "tilth_search",
			params: { query: "x" },
			cwd: "/tmp",
			scopeOptions: { defaultScope: true },
		});
		expect(result.text).toBe("result text");
		expect(result.scopedParams).toEqual({ query: "x", root: "/tmp", scope: "/tmp" });
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.toolName).toBe("tilth_search");
		expect(transport.calls[0]?.params).toEqual({ query: "x", root: "/tmp", scope: "/tmp" });
	});

	it("search tools inject a default scope so the server never searches its own cwd", async () => {
		const { deps, transport } = makeDeps(() => "ok");
		deps.availability.mode = "binary";
		const result = await runTilthCall({
			deps,
			toolName: "tilth_search",
			params: { query: "x" },
			cwd: "/work/repo",
			scopeOptions: { defaultScope: true },
		});
		// The server resolves an omitted scope to its own process cwd and ignores
		// `root` for that purpose; the extension anchors the default scope itself.
		expect(result.scopedParams.scope).toBe("/work/repo");
		expect(transport.calls[0]?.params.scope).toBe("/work/repo");
	});

	it("scopes relative paths against cwd before the transport call", async () => {
		const { deps, transport } = makeDeps(() => "ok");
		deps.availability.mode = "binary";
		await runTilthCall({
			deps,
			toolName: "tilth_read",
			params: { path: "src/a.ts" },
			cwd: "/work",
		});
		expect(transport.calls[0]?.params.root).toBe("/work");
		expect(transport.calls[0]?.params.path).toBe("/work/src/a.ts");
	});

	it("propagates ServerToolError from the transport (tool result marked failed)", async () => {
		const { deps } = makeDeps(() => {
			throw new ServerToolError("file not found: /x");
		});
		deps.availability.mode = "binary";
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_read",
				params: { path: "/x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow("file not found: /x");
	});

	it("propagates TransportError from the transport", async () => {
		const { deps } = makeDeps(() => {
			throw new TransportError("tilth MCP transport error: connection refused");
		});
		deps.availability.mode = "binary";
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_search",
				params: { query: "x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow("connection refused");
	});

	it("throws when availability has not been probed yet", async () => {
		const { deps, transport } = makeDeps(() => {
			throw new Error("must not call");
		});
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_search",
				params: { query: "x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow(/not been probed/);
		expect(transport.calls).toHaveLength(0);
	});
});

describe("tool parameters — typebox schemas mirror the server", () => {
	it("read tool accepts the documented parameter names", async () => {
		const tools = await loadRegisteredTools();
		const read = tools.get("tilth_read");
		expect(read).toBeDefined();
		const props = (
			(read?.parameters as { properties: Record<string, unknown> }) ?? {
				properties: {},
			}
		).properties;
		for (const key of ["path", "paths", "section", "sections", "mode", "full", "budget", "raw", "root"]) {
			expect(props[key], `tilth_read.${key}`).toBeDefined();
		}
	});

	it("raw is the only client-only param — all other read params exist in the server schema", async () => {
		const tools = await loadRegisteredTools();
		const read = tools.get("tilth_read");
		const props = (
			(read?.parameters as { properties: Record<string, unknown> }) ?? {
				properties: {},
			}
		).properties;
		const serverSchema = fixtureTools.find((t) => t.name === "tilth_read")?.inputSchema as {
			properties: Record<string, unknown>;
		};
		const serverProps = serverSchema.properties ?? {};
		for (const key of Object.keys(props)) {
			if (key === "raw") continue;
			expect((serverProps as Record<string, unknown>)[key], `server tilth_read.${key}`).toBeDefined();
		}
	});
});
