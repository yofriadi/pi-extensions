import { describe, expect, it } from "vitest";
import { resolveGitProvenance } from "../src/git.ts";

interface ExecCall {
	command: string;
	args: string[];
	options?: { cwd?: string; timeout?: number };
}

function makeFakePi(responses: Record<string, { code: number; stdout: string; killed?: boolean }>) {
	const calls: ExecCall[] = [];
	return {
		calls,
		pi: {
			exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
				calls.push({ command, args, options });
				const key = args.join(" ");
				const response = responses[key] ?? { code: 1, stdout: "" };
				return {
					stdout: response.stdout,
					stderr: "",
					code: response.code,
					killed: response.killed ?? false,
				};
			},
		},
	};
}

describe("resolveGitProvenance", () => {
	it("returns commit, branch, and repo URL for a normal repo", async () => {
		const { pi, calls } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "https://github.com/org/repo.git\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance).toEqual({
			commit: "abc123",
			branch: "main",
			repoUrl: "https://github.com/org/repo.git",
		});
		// Every git subprocess must be bounded so hung helpers can't delay provenance forever.
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.options?.timeout).toBe(2_000);
			expect(call.options?.cwd).toBe("/repo");
		}
	});

	it("returns undefined when not inside a git repository", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 128, stdout: "" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/not-a-repo");

		expect(provenance).toBeUndefined();
	});

	it("returns undefined when the commit lookup is killed by timeout", async () => {
		const { pi, calls } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "", killed: true },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options?.timeout).toBe(2_000);
	});

	it("omits branch/remote when those lookups are killed, but keeps the commit", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n", killed: true },
			"remote get-url origin": { code: 0, stdout: "https://github.com/org/repo.git\n", killed: true },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance).toEqual({ commit: "abc123", branch: undefined, repoUrl: undefined });
	});

	it("omits branch for a detached HEAD checkout instead of reporting 'HEAD'", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
			"remote get-url origin": { code: 1, stdout: "" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.branch).toBeUndefined();
	});

	it("resolves commit alone when there is no remote configured", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 128, stdout: "" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance).toEqual({ commit: "abc123", branch: "main", repoUrl: undefined });
	});

	it("strips embedded credentials from an https remote URL before returning it", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "https://user:ghp_secrettoken@github.com/org/repo.git\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).not.toContain("ghp_secrettoken");
		expect(provenance?.repoUrl).not.toContain("user:");
		expect(provenance?.repoUrl).toBe("https://github.com/org/repo.git");
	});

	it("leaves an ssh-shorthand remote URL (no parseable userinfo) unchanged", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "git@github.com:org/repo.git\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).toBe("git@github.com:org/repo.git");
	});

	it("strips credentials from ssh:// userinfo URLs", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "ssh://deploy:s3cret@git.example.com/org/repo.git\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).not.toContain("s3cret");
		expect(provenance?.repoUrl).not.toContain("deploy");
		expect(provenance?.repoUrl).toBe("ssh://git.example.com/org/repo.git");
	});

	it("strips query-string tokens from remote URLs (CI PAT conventions)", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": {
				code: 0,
				stdout: "https://github.com/org/repo.git?token=SECRET123&login=bot\n",
			},
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).not.toContain("SECRET123");
		expect(provenance?.repoUrl).not.toContain("?");
		expect(provenance?.repoUrl).toBe("https://github.com/org/repo.git");
	});

	it("strips fragment tokens from remote URLs", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": {
				code: 0,
				stdout: "https://github.com/org/repo.git#access_token=SECRET_FRAGMENT\n",
			},
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).not.toContain("SECRET_FRAGMENT");
		expect(provenance?.repoUrl).not.toContain("#");
		expect(provenance?.repoUrl).toBe("https://github.com/org/repo.git");
	});

	it("strips userinfo, query, and fragment together when all are present", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": {
				code: 0,
				stdout: "https://user:pass@github.com/org/repo.git?token=Q&x=1#access_token=F\n",
			},
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).toBe("https://github.com/org/repo.git");
	});

	it("omits SCP-style remotes that still carry a query-string token", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "git@github.com:org/repo.git?token=SECRET\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).toBeUndefined();
	});

	it("omits SCP-style remotes with password-like userinfo", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "user:pass@github.com:org/repo.git\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).toBeUndefined();
	});

	it("omits unparseable helper transports rather than exporting them raw", async () => {
		const { pi } = makeFakePi({
			"rev-parse HEAD": { code: 0, stdout: "abc123\n" },
			"rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
			"remote get-url origin": { code: 0, stdout: "ext::sh -c 'echo https://token@host/repo'\n" },
		});

		const provenance = await resolveGitProvenance(pi as never, "/repo");

		expect(provenance?.repoUrl).toBeUndefined();
	});
});
