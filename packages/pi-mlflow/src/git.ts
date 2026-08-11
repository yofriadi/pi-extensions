import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitProvenance {
	commit: string;
	branch?: string;
	repoUrl?: string;
}

/**
 * Bound every git subprocess so a hung credential helper, NFS stall, or
 * broken pager cannot delay provenance forever. Lifecycle starts this off
 * the agent-loop critical path at `agent_start`, then awaits the already-
 * started lookup at `agent_settled` before ending/exporting the root so
 * ordinary slow repositories still keep branch/commit metadata. These
 * per-exec caps are what keep that settle wait bounded.
 * Provenance is best-effort metadata — prefer "no git info" over hanging.
 */
const GIT_EXEC_TIMEOUT_MS = 2_000;

/**
 * Resolve the current git commit, branch, and remote URL (if any) at the
 * start of a trace. Returns undefined if the cwd is not inside a git repo or
 * git is unavailable. Never throws — git provenance is best-effort metadata,
 * not a hard dependency.
 */
export async function resolveGitProvenance(pi: ExtensionAPI, cwd: string): Promise<GitProvenance | undefined> {
	try {
		const commitResult = await pi.exec("git", ["rev-parse", "HEAD"], {
			cwd,
			timeout: GIT_EXEC_TIMEOUT_MS,
		});
		if (commitResult.code !== 0 || commitResult.killed) {
			return undefined;
		}
		const commit = commitResult.stdout.trim();
		if (!commit) {
			return undefined;
		}

		// Branch and remote are independent once we have a commit — fetch them
		// in parallel so a slow (but still within-timeout) lookup on one path
		// does not serialize the other.
		const [branch, repoUrl] = await Promise.all([resolveBranch(pi, cwd), resolveRemoteUrl(pi, cwd)]);

		return { commit, branch, repoUrl };
	} catch {
		return undefined;
	}
}

async function resolveBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			timeout: GIT_EXEC_TIMEOUT_MS,
		});
		if (branchResult.code !== 0 || branchResult.killed) {
			return undefined;
		}
		const name = branchResult.stdout.trim();
		// "HEAD" is what git prints for a detached-HEAD checkout; that's not
		// a real branch name, so omit it rather than reporting nonsense.
		if (name && name !== "HEAD") {
			return name;
		}
		return undefined;
	} catch {
		// Best-effort; commit alone is still useful.
		return undefined;
	}
}

async function resolveRemoteUrl(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], {
			cwd,
			timeout: GIT_EXEC_TIMEOUT_MS,
		});
		if (remoteResult.code !== 0 || remoteResult.killed) {
			return undefined;
		}
		const url = remoteResult.stdout.trim();
		if (!url) {
			return undefined;
		}
		// `undefined` means "cannot prove safe" — omit rather than export a
		// remote that might still embed credentials.
		return sanitizeRemoteUrl(url);
	} catch {
		// No remote configured; commit alone is still useful.
		return undefined;
	}
}

/**
 * Strip embedded credentials from a git remote URL before it's exported as
 * always-on metadata (e.g. `https://user:token@github.com/...`). This
 * structural metadata is captured regardless of `captureContent`, so it must
 * never carry secrets even when content capture is disabled.
 *
 * Returns `undefined` when the remote cannot be proven safe to export —
 * better to omit provenance than to leak a token into always-on metadata.
 *
 * WHATWG-parseable URLs:
 * - clear userinfo (`user:pass@host`)
 * - drop query string and fragment entirely (CI/hosting PATs often live in
 *   `?token=` / `?access_token=` / `#access_token=` rather than userinfo)
 *
 * Non-WHATWG forms (SCP-style `user@host:path`):
 * - only the well-known bare SSH shorthand is accepted, and only when it
 *   contains no `?`/`#` and no `:` in the user part (no password-like userinfo)
 * - any other unparseable form is omitted rather than returned verbatim
 */
function sanitizeRemoteUrl(url: string): string | undefined {
	// Node's WHATWG URL parser accepts many scheme-less strings (e.g.
	// `user:pass@host:path`, `ext::helper`) and returns them nearly unchanged.
	// Only treat inputs with an explicit scheme as real URLs; everything else
	// goes through the strict SCP-style allowlist (or is omitted).
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
		return sanitizeScpStyleRemote(url);
	}

	try {
		const parsed = new URL(url);
		// Require a real hierarchical host — reject opaque/scheme-only oddities.
		if (!parsed.protocol || !parsed.host) {
			return undefined;
		}
		let mutated = false;
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			mutated = true;
		}
		// Drop search/hash entirely rather than trying to filter "credential-
		// looking" params — safer and simpler, and path/host alone is enough for
		// provenance. An empty search/hash is a no-op mutate.
		if (parsed.search) {
			parsed.search = "";
			mutated = true;
		}
		if (parsed.hash) {
			parsed.hash = "";
			mutated = true;
		}
		return mutated ? parsed.toString() : url;
	} catch {
		return sanitizeScpStyleRemote(url);
	}
}

/**
 * Accept only a bare SCP-style remote (`user@host:path` / `host:path`) with
 * no query, fragment, or password-like userinfo. Anything else is omitted.
 *
 * Examples accepted: `git@github.com:org/repo.git`, `github.com:org/repo.git`
 * Examples rejected: `git@host:path?token=…`, `user:pass@host:path`,
 * `token@host:path?x=1`, helper transports, arbitrary free-form strings.
 */
function sanitizeScpStyleRemote(url: string): string | undefined {
	// Reject any form that still carries query/fragment-style secret channels,
	// URL schemes, or helper-transport double-colon forms (`ext::…`).
	if (url.includes("?") || url.includes("#") || url.includes("://") || url.includes("::")) {
		return undefined;
	}

	// Optional simple-user@, then host, then :path. The user group is [\w.-]+ so
	// `user:pass@host:path` cannot match as userinfo — and if it instead matches
	// as host=`user` path=`pass@host:path`, the `@` in the path is rejected below.
	const match = /^(?:([\w.-]+)@)?([\w.-]+):(.+)$/.exec(url);
	if (!match) {
		return undefined;
	}
	const [, user, host, path] = match;
	// Empty / colon-leading path (e.g. residual from `ext::…`) or any `@` left in
	// the path means we couldn't cleanly parse a bare SCP remote — omit it.
	if (!path || path.startsWith(":") || path.includes("@")) {
		return undefined;
	}
	return user ? `${user}@${host}:${path}` : `${host}:${path}`;
}
