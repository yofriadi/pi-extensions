/**
 * Integration test harness for pi-subagent-herdr.
 *
 * Provides utilities to:
 * - Detect whether herdr is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in herdr panes with the parent surface's
 *   Herdr identity injected (so attached layout splits the test parent,
 *   not the runner pane)
 * - Inspect pane layout / identity
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	closePane,
	createSubagentPane,
	getHerdrPaneLayout,
	type HerdrLayoutPane,
	type HerdrPaneLayout,
	herdrPaneExists,
	interruptPane,
	isTerminalAvailable,
	readPane,
	readPaneAsync,
	runInPane,
	runScriptInPane,
	shellQuote,
} from "../../src/terminal.ts";

type MuxBackend = "herdr";

// Re-export mux primitives for tests
export {
	createSubagentPane,
	runInPane,
	runScriptInPane,
	readPane,
	readPaneAsync,
	closePane,
	interruptPane,
	shellQuote,
	getHerdrPaneLayout,
	herdrPaneExists,
};
export type { MuxBackend, HerdrPaneLayout, HerdrLayoutPane };

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");
const TEST_SKILLS_SRC = join(HARNESS_DIR, "skills");
export const PERMISSION_EXTENSION = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"npm",
	"node_modules",
	"@gotgenes",
	"pi-permission-system",
	"src",
	"index.ts",
);

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "src", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "tokenrouter/gpt-5.6-luna";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/** Detect whether the required herdr backend is available. */
export function getAvailableBackends(): MuxBackend[] {
	return isTerminalAvailable() ? ["herdr"] : [];
}

export function setBackend(_backend: MuxBackend): undefined {
	return undefined;
}

export function restoreBackend(_prev: string | undefined): void {}

export function focusSurface(_backend: MuxBackend, surface: string): void {
	// Focus the tab containing the pane — herdr has no direct "focus pane X"
	// CLI, but focusing the tab brings it to the foreground.
	const info = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
	const tabId = JSON.parse(info)?.result?.pane?.tab_id;
	if (tabId) execFileSync("herdr", ["tab", "focus", tabId], { encoding: "utf8" });
}

export function getFocusedSurface(_backend: MuxBackend): string | null {
	try {
		const info = execFileSync("herdr", ["pane", "current"], { encoding: "utf8" });
		return JSON.parse(info)?.result?.pane?.pane_id ?? null;
	} catch {
		return null;
	}
}

export function getSurfacePane(_backend: MuxBackend, surface: string): string | null {
	return surface;
}

export async function waitForFocusedSurface(
	backend: MuxBackend,
	surface: string,
	timeout: number = PI_TIMEOUT,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (getFocusedSurface(backend) === surface) return;
		await sleep(200);
	}

	throw new Error(
		`Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
			`current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
	);
}

// ── Test environment ──

export interface TestEnv {
	/** Temp directory serving as the test project root */
	dir: string;
	/** Active mux backend for this test run */
	backend: MuxBackend;
	/** Dedicated workspace owned by this test environment. */
	workspaceId: string;
	/** Parent workspace restored after cleanup. */
	previousWorkspaceId: string | undefined;
	previousInspectionDir: string | undefined;
	inspectionDir: string;
	/** Surfaces created directly by the harness. */
	surfaces: string[];
	/** Temp files to clean up */
	tempFiles: string[];
}

function createTestWorkspace(cwd: string): string {
	const output = execFileSync(
		"herdr",
		["workspace", "create", "--cwd", cwd, "--label", `pi-integ-${Date.now()}`, "--no-focus"],
		{ encoding: "utf8" },
	);
	const parsed = JSON.parse(output) as { result?: { workspace?: { workspace_id?: unknown } } };
	const workspaceId = parsed.result?.workspace?.workspace_id;
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new Error(`Unexpected herdr workspace create output: ${output.trim() || "(empty)"}`);
	}
	return workspaceId;
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(backend: MuxBackend): TestEnv {
	const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
	const agentsDir = join(dir, ".pi", "agents");
	const isolatedAgentDir = join(dir, ".pi", "isolated-agent");
	const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
	const previousInspectionDir = process.env.PI_SUBAGENT_INSPECTION_DIR;
	const inspectionDir = join(dir, ".pi", "subagent-inspection");
	if (!previousWorkspaceId) throw new Error("HERDR_WORKSPACE_ID is required for integration tests");
	const workspaceId = createTestWorkspace(dir);
	// Herdr creates subagent tabs in the workspace identified by this env var.
	// Point the harness at its dedicated workspace without changing the parent's pane.
	process.env.HERDR_WORKSPACE_ID = workspaceId;
	process.env.PI_SUBAGENT_INSPECTION_DIR = inspectionDir;
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(isolatedAgentDir, { recursive: true });
	for (const file of ["models.json", "models-store.json", "auth.json"]) {
		const source = join(homedir(), ".pi", "agent", file);
		if (existsSync(source)) cpSync(source, join(isolatedAgentDir, file));
	}
	writeFileSync(join(isolatedAgentDir, "settings.json"), "{}\n", "utf8");
	mkdirSync(join(dir, ".pi", "extensions", "pi-permission-system"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "extensions", "pi-permission-system", "config.json"),
		JSON.stringify({ yoloMode: false }) + "\n",
		"utf8",
	);

	// Copy test agent definitions into the project-local agents dir and pin
	// every child subagent to the same model selected for the outer Pi sessions.
	// Without this rewrite, fixture frontmatter can silently bypass PI_TEST_MODEL.
	if (existsSync(TEST_AGENTS_SRC)) {
		for (const file of readdirSync(TEST_AGENTS_SRC)) {
			if (file.endsWith(".md")) {
				const source = readFileSync(join(TEST_AGENTS_SRC, file), "utf8");
				const configured = /^model:\s*.*$/m.test(source)
					? source.replace(/^model:\s*.*$/m, `model: ${TEST_MODEL}`)
					: source.replace(/^---\n/, `---\nmodel: ${TEST_MODEL}\n`);
				writeFileSync(join(agentsDir, file), configured, "utf8");
			}
		}
	}
	if (existsSync(TEST_SKILLS_SRC)) {
		cpSync(TEST_SKILLS_SRC, join(dir, ".pi", "skills"), { recursive: true });
	}

	return {
		dir,
		backend,
		workspaceId,
		previousWorkspaceId,
		previousInspectionDir,
		inspectionDir,
		surfaces: [],
		tempFiles: [],
	};
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
	// Close only surfaces explicitly owned by the harness. The dedicated
	// workspace is then closed as a final safety net for extension-created panes.
	for (const surface of env.surfaces) {
		try {
			closePane(surface);
		} catch {}
	}
	try {
		execFileSync("herdr", ["workspace", "close", env.workspaceId], { encoding: "utf8" });
	} catch {}
	if (env.previousWorkspaceId) {
		process.env.HERDR_WORKSPACE_ID = env.previousWorkspaceId;
	} else {
		delete process.env.HERDR_WORKSPACE_ID;
	}
	if (env.previousInspectionDir) {
		process.env.PI_SUBAGENT_INSPECTION_DIR = env.previousInspectionDir;
	} else {
		delete process.env.PI_SUBAGENT_INSPECTION_DIR;
	}
	for (const file of env.tempFiles) {
		try {
			unlinkSync(file);
		} catch {}
	}
	try {
		rmSync(env.dir, { recursive: true, force: true });
	} catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
	const surface = createSubagentPane(name);
	env.surfaces.push(surface);
	return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
	env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pane identity / layout inspection ──

/**
 * Herdr identity for a pane (from `herdr pane get`).
 * Used so child pi processes attach relative to the test parent surface,
 * not the integration-runner pane.
 */
export interface PaneIdentity {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

/** Parse `herdr pane get <surface>` into stable identity fields. */
export function getPaneIdentity(surface: string): PaneIdentity {
	const output = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
	const start = output.indexOf("{");
	if (start < 0) throw new Error(`Unexpected herdr pane get output: ${output.trim() || "(empty)"}`);
	const parsed = JSON.parse(output.slice(start)) as {
		result?: { pane?: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown } };
	};
	const pane = parsed.result?.pane;
	const paneId = pane?.pane_id;
	const tabId = pane?.tab_id;
	const workspaceId = pane?.workspace_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`herdr pane get missing pane_id: ${output.trim()}`);
	}
	if (typeof tabId !== "string" || !tabId) {
		throw new Error(`herdr pane get missing tab_id: ${output.trim()}`);
	}
	if (typeof workspaceId !== "string" || !workspaceId) {
		throw new Error(`herdr pane get missing workspace_id: ${output.trim()}`);
	}
	return { paneId, tabId, workspaceId };
}

/** Snapshot `herdr pane layout --pane <id>` (null if unavailable). */
export function getLayoutSnapshot(paneId: string): HerdrPaneLayout | null {
	return getHerdrPaneLayout(paneId);
}

/** Count panes in a layout excluding the parent/main pane. */
export function countChildPanes(layout: HerdrPaneLayout, parentPaneId: string): number {
	return layout.panes.filter((p) => p.paneId !== parentPaneId).length;
}

/**
 * Poll until the parent tab's layout has at least `minChildren` non-parent panes.
 */
export async function waitForChildPaneCount(
	parentPaneId: string,
	minChildren: number,
	timeout: number = PI_TIMEOUT,
): Promise<HerdrPaneLayout> {
	const start = Date.now();
	let last: HerdrPaneLayout | null = null;
	while (Date.now() - start < timeout) {
		last = getLayoutSnapshot(parentPaneId);
		if (last && countChildPanes(last, parentPaneId) >= minChildren) return last;
		await sleep(500);
	}
	const n = last ? countChildPanes(last, parentPaneId) : 0;
	throw new Error(
		`Timeout (${timeout}ms) waiting for ≥${minChildren} child panes of ${parentPaneId}; saw ${n}. ` +
			`layout=${last ? JSON.stringify(last.panes.map((p) => ({ id: p.paneId, ...p.rect }))) : "null"}`,
	);
}

/** Poll until a pane no longer exists (closed / reaped). */
export async function waitForPaneGone(paneId: string, timeout: number = PI_TIMEOUT): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (!herdrPaneExists(paneId)) return;
		await sleep(400);
	}
	throw new Error(`Timeout (${timeout}ms) waiting for pane ${paneId} to disappear`);
}

// ── Pi session management ──

/**
 * Start a pi session in a herdr pane with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * Injects the **surface's** Herdr identity into the child process env so
 * attached-layout spawns split this pane (not the test runner's pane).
 * Does not mutate the runner's process.env HERDR_* globals.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 *
 * When `opts.sessionFile` is set, pi is started with `--session` so the
 * parent JSONL is at a known path (for steer / tool-result inspection).
 */
export function startPi(
	surface: string,
	testDir: string,
	task: string,
	opts?: {
		model?: string;
		extraArgs?: string;
		sessionFile?: string;
		env?: Record<string, string>;
		noExtensions?: boolean;
	},
): { identity: PaneIdentity; sessionFile?: string } {
	const model = opts?.model ?? TEST_MODEL;
	const extra = opts?.extraArgs ?? "";
	const identity = getPaneIdentity(surface);
	const sessionFile = opts?.sessionFile;

	// Force pi to load the working-tree extension (not an installed pi-package
	// snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
	// current branch's source directly.
	const envPrefix = [
		`HERDR_ENV=1`,
		`HERDR_PANE_ID=${shellQuote(identity.paneId)}`,
		`HERDR_TAB_ID=${shellQuote(identity.tabId)}`,
		`HERDR_WORKSPACE_ID=${shellQuote(identity.workspaceId)}`,
		...(process.env.PI_SUBAGENT_INSPECTION_DIR
			? [`PI_SUBAGENT_INSPECTION_DIR=${shellQuote(process.env.PI_SUBAGENT_INSPECTION_DIR)}`]
			: []),
		...Object.entries(opts?.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`),
	].join(" ");

	const sessionArg = sessionFile ? `--session ${shellQuote(sessionFile)}` : "";

	const cmd = [
		`cd ${shellQuote(testDir)} &&`,
		envPrefix,
		`pi`,
		...(opts?.noExtensions === false ? [] : ["-ne"]),
		`--approve`,
		`-e ${shellQuote(EXTENSION_SOURCE)}`,
		`--model ${shellQuote(model)}`,
		sessionArg,
		extra,
		shellQuote(task),
	]
		.filter(Boolean)
		.join(" ");

	runScriptInPane(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
		scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
	});

	return { identity, sessionFile };
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
	surface: string,
	pattern: RegExp,
	timeout: number = PI_TIMEOUT,
	lines: number = 200,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const screen = await readPaneAsync(surface, lines);
			if (pattern.test(screen)) return screen;
		} catch {}
		await sleep(2000);
	}

	let finalScreen = "";
	try {
		finalScreen = readPane(surface, lines);
	} catch {}
	throw new Error(
		`Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
	);
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForInspection(
	env: TestEnv,
	predicate: (inspection: any) => boolean,
	timeout: number = PI_TIMEOUT,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (existsSync(env.inspectionDir)) {
			for (const file of readdirSync(env.inspectionDir)) {
				if (!file.endsWith(".json")) continue;
				try {
					const inspection = JSON.parse(readFileSync(join(env.inspectionDir, file), "utf8"));
					if (predicate(inspection)) return inspection;
				} catch {}
			}
		}
		await sleep(200);
	}
	throw new Error(`Timeout (${timeout}ms) waiting for subagent inspection`);
}

export async function waitForFile(
	path: string,
	timeout: number = PI_TIMEOUT,
	contentPattern?: RegExp,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf8");
			if (!contentPattern || contentPattern.test(content)) return content;
		}
		await sleep(2000);
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for file: ${path}` + (contentPattern ? ` matching ${contentPattern}` : ""),
	);
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(surface: string, timeout: number = PI_TIMEOUT): Promise<number> {
	const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
	const match = screen.match(/__TEST_DONE_(\d+)__/);
	return match ? parseInt(match[1], 10) : -1;
}

/**
 * Count JSONL entries of a given customType (or any type field) in a session file.
 */
export function countSessionEntries(
	sessionFile: string,
	predicate: (entry: Record<string, unknown>) => boolean,
): number {
	if (!existsSync(sessionFile)) return 0;
	const lines = readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
	let n = 0;
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (predicate(entry)) n += 1;
		} catch {
			// skip malformed
		}
	}
	return n;
}

/** Count steered subagent_result custom messages in a parent session JSONL. */
export function countSubagentResultSteers(sessionFile: string, expectedRunId?: string): number {
	const matches = (candidate: Record<string, any> | undefined): boolean => {
		if (!candidate || candidate.customType !== "subagent_result") return false;
		if (!expectedRunId) return true;
		const details = candidate.details ?? candidate.data?.details;
		return details?.id === expectedRunId;
	};
	return countSessionEntries(sessionFile, (entry) => {
		if (matches(entry)) return true;
		return matches(entry.message as Record<string, any> | undefined);
	});
}

/** Resolve the run ID returned by a successful async subagent tool call. */
export function findSubagentLaunchRunId(sessionFile: string, expectedName: string): string | undefined {
	if (!existsSync(sessionFile)) return undefined;
	const lines = readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as Record<string, any>;
			for (const candidate of [entry.message, entry]) {
				if (candidate?.role !== "toolResult" || candidate.toolName !== "subagent") continue;
				if (candidate.details?.name === expectedName && typeof candidate.details?.id === "string") {
					return candidate.details.id;
				}
			}
		} catch {
			// skip malformed/partial lines
		}
	}
	return undefined;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
	env.tempFiles.push(path);
}
