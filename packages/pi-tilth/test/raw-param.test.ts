/**
 * tilth_read's `raw` param (client-side only):
 *
 *  - stripped from the params forwarded to the server (the server schema has
 *    no raw — annotation is purely extension-side),
 *  - skips the hashline annotation pass even when compat is active,
 *  - leaves the passthrough/annotate behavior unchanged when absent or false.
 *
 * Driven through the real registered-tool execute path (registerTilthTool) —
 * the same surface pi calls — with a fake transport seam and fake compat module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createAvailabilityState } from "../src/lib/availability";
import type { CompatModule } from "../src/lib/hashline-bridge";
import { runTilthCall, type TilthToolDeps } from "../src/toolkit";
import { registerReadTool } from "../src/tools/read";
import { asTilthTransport, createFakeTransport, type FakeTransport } from "./helpers/fake-transport";

const FIXTURE_PATH = "/abs/file.ts";

/** Section-view server output for a 2-line file. */
const SERVER_SECTION_OUTPUT = [
	`# ${FIXTURE_PATH} (4 lines, ~40 tokens) [section]`,
	"",
	"1  line one",
	"2  line two",
	"",
	"",
].join("\n");

/** Matches pi's execute arity: (id, params, signal, onUpdate, ctx). */
interface RegisteredToolStub {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<unknown>;
}

function makeDeps(): { deps: TilthToolDeps; transport: FakeTransport } {
	const compat: CompatModule = {
		COMPAT_VERSION: 1,
		isHashlineEditActive: () => true,
		readNormalizedForAnnotate: vi.fn(async () => ({
			normalized: "line one\nline two\nline three\nline four",
			lines: ["line one", "line two", "line three", "line four"],
		})),
		commitExternalRead: vi.fn(async () => {}),
		mintAnchor: vi.fn((_fileLines: string[], line1: number) => `#${line1}anchor`),
	};
	const transport = createFakeTransport(() => SERVER_SECTION_OUTPUT);
	const deps: TilthToolDeps = {
		transport: asTilthTransport(transport),
		availability: createAvailabilityState(),
		config: { callTimeoutMs: 60_000, hashlineCompat: true },
		compat,
	};
	deps.availability.mode = "binary";
	return { deps, transport };
}

function makePi() {
	const registered: Array<RegisteredToolStub> = [];
	const api = {
		registerTool: (def: RegisteredToolStub) => {
			registered.push(def);
		},
	} as unknown as ExtensionAPI;
	return { api, registered };
}

describe("tilth_read raw param — client-side anchor opt-out", () => {
	it("annotates when raw is absent (baseline)", async () => {
		const { deps } = makeDeps();
		const { api, registered } = makePi();
		registerReadTool(api, deps);
		const tool = registered.find((t) => t.name === "tilth_read");
		expect(tool).toBeDefined();
		const result = (await tool?.execute("id", { path: FIXTURE_PATH, section: "1-2" }, undefined, undefined, {
			cwd: "/tmp",
		})) as {
			content: Array<{ type: string; text: string }>;
		};
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("#1anchor");
		expect(deps.compat?.commitExternalRead).toHaveBeenCalledWith(
			FIXTURE_PATH,
			"line one\nline two\nline three\nline four",
		);
	});

	it("strips raw from the params forwarded to the server", async () => {
		const { deps, transport } = makeDeps();
		const { api, registered } = makePi();
		registerReadTool(api, deps);
		const tool = registered.find((t) => t.name === "tilth_read");
		await tool?.execute("id", { path: FIXTURE_PATH, section: "1-2", raw: true }, undefined, undefined, {
			cwd: "/tmp",
		});
		const payload = transport.calls[0]?.params ?? {};
		expect(payload).not.toHaveProperty("raw");
		expect(payload).toHaveProperty("path", FIXTURE_PATH);
		expect(payload).toHaveProperty("section", "1-2");
		expect(payload).toHaveProperty("root", "/tmp");
	});

	it("skips annotation and commits nothing when raw: true", async () => {
		const { deps } = makeDeps();
		const { api, registered } = makePi();
		registerReadTool(api, deps);
		const tool = registered.find((t) => t.name === "tilth_read");
		const result = (await tool?.execute(
			"id",
			{ path: FIXTURE_PATH, section: "1-2", raw: true },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as {
			content: Array<{ type: string; text: string }>;
		};
		const text = result.content[0]?.text ?? "";
		expect(text).not.toContain("#1anchor");
		expect(text).toContain("1  line one");
		expect(deps.compat?.commitExternalRead).not.toHaveBeenCalled();
		expect(deps.compat?.readNormalizedForAnnotate).not.toHaveBeenCalled();
	});

	it("raw: false behaves like absent (annotates)", async () => {
		const { deps } = makeDeps();
		const { api, registered } = makePi();
		registerReadTool(api, deps);
		const tool = registered.find((t) => t.name === "tilth_read");
		const result = (await tool?.execute(
			"id",
			{ path: FIXTURE_PATH, section: "1-2", raw: false },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		)) as {
			content: Array<{ type: string; text: string }>;
		};
		expect((result.content[0]?.text ?? "").includes("#1anchor")).toBe(true);
	});

	it("runTilthCall forwards raw through scoping when called directly (server tolerates unknown keys)", () => {
		// Documents the current contract: runTilthCall itself does not filter —
		// registerTilthTool's execute is the single strip point.
		const { deps } = makeDeps();
		return expect(
			runTilthCall({ deps, toolName: "tilth_read", params: { raw: true, path: FIXTURE_PATH }, cwd: "/tmp" }),
		).resolves.toHaveProperty("scopedParams.root", "/tmp");
	});
});
