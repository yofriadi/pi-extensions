import type { ParsedCommitCommandArgs } from "./types.js";

const FLAG_ALIASES = new Map<string, string>([
	["-c", "--context"],
	["-m", "--model"],
	["-h", "--help"],
]);

export function parseCommitCommandArgs(
	raw: string,
): { ok: true; value: ParsedCommitCommandArgs } | { ok: false; error: string } {
	const tokensResult = tokenizeArgs(raw);
	if (!tokensResult.ok) {
		return tokensResult;
	}

	const tokens = tokensResult.tokens;
	const parsed: ParsedCommitCommandArgs = {
		push: false,
		dryRun: false,
		noChangelog: false,
		legacy: false,
		split: false,
		noSplit: false,
		allowMixedIndex: false,
		help: false,
	};

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		const flag = FLAG_ALIASES.get(token) ?? token;

		switch (flag) {
			case "--push":
				parsed.push = true;
				break;
			case "--dry-run":
				parsed.dryRun = true;
				break;
			case "--no-changelog":
				parsed.noChangelog = true;
				break;
			case "--legacy":
				parsed.legacy = true;
				break;
			case "--split":
				parsed.split = true;
				break;
			case "--no-split":
				parsed.noSplit = true;
				break;
			case "--allow-mixed-index":
				parsed.allowMixedIndex = true;
				break;
			case "--help":
				parsed.help = true;
				break;
			case "--context": {
				const value = tokens[index + 1];
				if (!value || value.startsWith("-")) {
					return { ok: false, error: "--context requires a value" };
				}
				parsed.context = value;
				index += 1;
				break;
			}
			case "--model": {
				const value = tokens[index + 1];
				if (!value || value.startsWith("-")) {
					return { ok: false, error: "--model requires a value" };
				}
				parsed.model = value;
				index += 1;
				break;
			}
			case "--max-split-commits": {
				const value = tokens[index + 1];
				if (!value || value.startsWith("-")) {
					return { ok: false, error: "--max-split-commits requires a numeric value" };
				}
				const parsedValue = Number.parseInt(value, 10);
				if (!Number.isFinite(parsedValue) || parsedValue < 2 || parsedValue > 12) {
					return { ok: false, error: "--max-split-commits must be an integer between 2 and 12" };
				}
				parsed.maxSplitCommits = parsedValue;
				index += 1;
				break;
			}
			default:
				if (flag.startsWith("-")) {
					return { ok: false, error: `Unknown flag: ${flag}` };
				}
				return { ok: false, error: `Unexpected argument: ${flag}` };
		}
	}

	if (parsed.split && parsed.noSplit) {
		return { ok: false, error: "--split and --no-split cannot be used together" };
	}

	return { ok: true, value: parsed };
}

function tokenizeArgs(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;

	for (const char of input.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) {
		current += "\\";
	}

	if (quote) {
		return { ok: false, error: `Unterminated quote: ${quote}` };
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return { ok: true, tokens };
}

export function getCommitHelpText(): string {
	return [
		"Usage: /commit [options]",
		"",
		"Options:",
		"  --push                 Push after committing",
		"  --dry-run              Preview generated commit(s) without creating them",
		"  --split                Force split-commit planning",
		"  --no-split             Disable automatic split-commit planning",
		"  --max-split-commits    Cap AI split plan size (2-12)",
		"  --allow-mixed-index    Allow split mode with mixed staged/unstaged files",
		"  --no-changelog         Skip changelog updates",
		"  --legacy               Accepted for compatibility (same pipeline)",
		"  --context, -c          Additional context for commit generation",
		"  --model, -m            Override model (id or provider/id)",
		"  --help, -h             Show this help",
	].join("\n");
}
