import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAvailabilityState } from "../src/lib/availability";
import type { Exec } from "../src/lib/exec";
import { runTilthCall, type TilthToolDeps } from "../src/toolkit";

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

function makeDeps(exec: Exec): TilthToolDeps {
	return {
		exec,
		availability: createAvailabilityState(),
		config: { serverName: "tilth", callTimeoutMs: 60_000, hashlineCompat: false },
		compat: null,
	};
}

describe("runTilthCall — transport integration", () => {
	it("throws the static unavailable error without spawning", async () => {
		const deps = makeDeps(async () => {
			throw new Error("must not spawn");
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
	});

	it("issues exactly one mcporter call in config mode and returns joined text", async () => {
		let calls = 0;
		const deps = makeDeps(async (cmd, args) => {
			calls += 1;
			expect(cmd).toBe("mcporter");
			expect(args[0]).toBe("call");
			expect(args[1]).toBe("tilth.tilth_search");
			return {
				stdout: JSON.stringify({
					content: [{ type: "text", text: "result text" }],
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		});
		deps.availability.mode = "config";
		const result = await runTilthCall({
			deps,
			toolName: "tilth_search",
			params: { query: "x" },
			cwd: "/tmp",
			scopeOptions: { defaultScope: true },
		});
		expect(result.text).toBe("result text");
		expect(result.scopedParams).toEqual({ query: "x", root: "/tmp", scope: "/tmp" });
		expect(calls).toBe(1);
	});

	it("search tools inject a default scope so the server never searches its own cwd", async () => {
		const deps = makeDeps(async () => ({
			stdout: JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
			stderr: "",
			code: 0,
			killed: false,
		}));
		deps.availability.mode = "config";
		const result = await runTilthCall({
			deps,
			toolName: "tilth_search",
			params: { query: "x" },
			cwd: "/work/repo",
			scopeOptions: { defaultScope: true },
		});
		// Regression (2026-09-13): tilth resolves an omitted scope to its own
		// process cwd — for a keep-alive mcporter daemon that is the daemon
		// directory — and ignores `root` for that purpose. The extension must
		// anchor the default scope itself.
		expect(result.scopedParams.scope).toBe("/work/repo");
	});

	it("config mode scopes relative paths against cwd", async () => {
		const deps = makeDeps(async (_cmd, args) => {
			const argsIdx = args.indexOf("--args");
			const payload = JSON.parse(args[argsIdx + 1] ?? "{}") as Record<string, unknown>;
			expect(payload.root).toBe("/work");
			expect(payload.path).toBe("/work/src/a.ts");
			return {
				stdout: JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
				stderr: "",
				code: 0,
				killed: false,
			};
		});
		deps.availability.mode = "config";
		await runTilthCall({
			deps,
			toolName: "tilth_read",
			params: { path: "src/a.ts" },
			cwd: "/work",
		});
	});

	it("ad-hoc binary mode passes --yes and the stdio descriptor", async () => {
		const deps = makeDeps(async (_cmd, args) => {
			expect(args).toContain("--yes");
			const stdioIdx = args.indexOf("--stdio");
			expect(args[stdioIdx + 1]).toBe("tilth");
			return {
				stdout: JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
				stderr: "",
				code: 0,
				killed: false,
			};
		});
		deps.availability.mode = "binary";
		await runTilthCall({
			deps,
			toolName: "tilth_read",
			params: { path: "/x" },
			cwd: "/tmp",
		});
	});

	it("maps server isError envelopes to thrown errors (tool result marked failed)", async () => {
		const deps = makeDeps(async () => ({
			stdout: JSON.stringify({
				content: [{ type: "text", text: "file not found: /x" }],
				isError: true,
			}),
			stderr: "",
			code: 0,
			killed: false,
		}));
		deps.availability.mode = "config";
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_read",
				params: { path: "/x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow("file not found: /x");
	});

	it("maps transport failures to thrown errors carrying stderr", async () => {
		const deps = makeDeps(async () => ({
			stdout: "",
			stderr: "connection refused",
			code: 7,
			killed: false,
		}));
		deps.availability.mode = "config";
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
		const deps = makeDeps(async () => {
			throw new Error("must not spawn");
		});
		await expect(
			runTilthCall({
				deps,
				toolName: "tilth_search",
				params: { query: "x" },
				cwd: "/tmp",
			}),
		).rejects.toThrow(/not been probed/);
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
