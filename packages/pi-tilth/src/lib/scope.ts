/**
 * Root/scope argument preparation (design D3).
 *
 * Every tool call injects `root: <absolute ctx.cwd>` when the caller did not
 * supply `root`, and absolutizes any relative `path`/`paths`/`scope` against
 * the session cwd before invocation. A caller-supplied `root` is honored:
 * absolute values pass through unchanged (a deliberate escape hatch for
 * cross-repo queries against the same server) and relative values are
 * resolved against the session cwd like any other path.
 *
 * Tools whose `scope` is a search root (search/list/deps/grok) additionally
 * inject `scope: <resolved root>` when the caller omitted it: the tilth
 * server resolves an *omitted* scope to its own process cwd (frozen at
 * spawn — the transport's session_start cwd) and ignores `root` for that
 * purpose. Explicit anchoring keeps bare calls deterministic even when the
 * per-call session cwd differs from the spawn cwd.
 * `tilth_diff`'s scope is an output filter, not a search root, and
 * `tilth_read` takes no scope — neither opts in.
 *
 * Git references (`a`, `b`, `log` on tilth_diff) are not paths and pass
 * through untouched.
 */
import { isAbsolute, resolve } from "node:path";

export type ToolParams = Record<string, unknown>;

function absolutizePath(value: string, cwd: string): string {
	if (isAbsolute(value)) return value;
	return resolve(cwd, value);
}

function absolutizePaths(value: unknown, cwd: string): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((entry) => (typeof entry === "string" ? absolutizePath(entry, cwd) : entry));
}

/**
 * Options controlling scope preparation.
 */
export interface ScopeOptions {
	/**
	 * Inject `scope: <resolved root>` when the caller supplied no `scope`.
	 * Set only on tools whose `scope` is a search root: the server resolves an
	 * omitted scope to its own process cwd and ignores `root` for that
	 * purpose. Off for tilth_diff (scope = output filter) and tilth_read
	 * (no scope param).
	 */
	defaultScope?: boolean;
}

/**
 * Return the params forwarded to the server, with scoping applied.
 *
 * - `root` is filled in with the absolute session cwd when absent. A
 *   caller-supplied relative `root` is resolved against the cwd; an absolute
 *   one passes through unchanged.
 * - With `defaultScope`, an absent `scope` is injected as the resolved root
 *   (session cwd, or the caller-supplied `root` for cross-repo queries).
 * - `path`, `paths`, `scope`, and `context` (tilth_search's current-file
 *   hint) are absolutized against the session cwd when relative. Absolute
 *   values pass through.
 * - All other keys (including git refs such as tilth_diff's `a`/`b`/`log`)
 *   pass through untouched.
 */
export function applyScoping(params: ToolParams, cwd: string, options: ScopeOptions = {}): ToolParams {
	const scoped: ToolParams = { ...params };

	if (typeof scoped.root === "string" && !isAbsolute(scoped.root)) {
		scoped.root = resolve(cwd, scoped.root);
	} else if (scoped.root === undefined || scoped.root === null) {
		scoped.root = resolve(cwd);
	}

	if (typeof scoped.path === "string") {
		scoped.path = absolutizePath(scoped.path, cwd);
	}
	if (scoped.paths !== undefined) {
		scoped.paths = absolutizePaths(scoped.paths, cwd);
	}
	if (typeof scoped.scope === "string") {
		scoped.scope = absolutizePath(scoped.scope, cwd);
	} else if ((scoped.scope === undefined || scoped.scope === null) && options.defaultScope) {
		// The server resolves an omitted scope to its own process cwd (frozen
		// at spawn) and ignores `root` for scope resolution. Anchor the
		// default scope explicitly so bare calls always search the session
		// project, even when the per-call cwd differs from the spawn cwd.
		scoped.scope = scoped.root;
	}
	if (typeof scoped.context === "string") {
		// tilth_search's `context` is a file path ("the file the agent is
		// currently editing") — absolutize it like path/scope.
		scoped.context = absolutizePath(scoped.context, cwd);
	}

	return scoped;
}

/**
 * Absolute paths named by a tilth_read call (`path` plus `paths` entries),
 * de-duplicated, for the hashline annotation pass. Returns an empty list when
 * the call was an error or named no concrete file.
 */
export function readTargetPaths(params: ToolParams): string[] {
	const paths: string[] = [];
	if (typeof params.path === "string" && params.path.length > 0) {
		paths.push(params.path);
	}
	if (Array.isArray(params.paths)) {
		for (const entry of params.paths) {
			if (typeof entry === "string" && entry.length > 0) {
				paths.push(entry);
			}
		}
	}
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const p of paths) {
		if (!seen.has(p)) {
			seen.add(p);
			unique.push(p);
		}
	}
	return unique;
}
