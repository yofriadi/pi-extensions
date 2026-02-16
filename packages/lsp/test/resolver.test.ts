import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspConfigResolver } from "../src/config/resolver.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function isolatedEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: "",
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp config resolver", () => {
	it("resolves multi-server config entries with file-type routing metadata", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							fileTypes: [".ts", ".tsx"],
						},
						py: {
							server: process.execPath,
							fileTypes: [".py"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toHaveLength(2);
		expect(config.serverCommand).toEqual([process.execPath]);
		expect(config.servers[0]).toMatchObject({
			name: "ts",
			command: [process.execPath],
			fileTypes: [".ts", ".tsx"],
		});
		expect(config.servers[1]).toMatchObject({
			name: "py",
			command: [process.execPath],
			fileTypes: [".py"],
		});
	});

	it("allows project config to override user server metadata by name", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							fileTypes: [".ts"],
						},
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(cwd, ".pi", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							fileTypes: [".tsx"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0]).toMatchObject({
			name: "ts",
			command: [process.execPath],
			fileTypes: [".tsx"],
		});
	});

	it("preserves disabled=true when project override only updates metadata", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							disabled: true,
							fileTypes: [".ts"],
						},
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(cwd, ".pi", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							fileTypes: [".tsx"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toEqual([]);
		expect(config.serverCommand).toBeUndefined();
	});
});
