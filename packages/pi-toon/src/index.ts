import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-toon";
const STATE_FILE = "toon.json";

export type QueryCommand = "jaq" | "jq";

export const JSON_SYSTEM_PROMPT = `# JSON Handling — jaq/jq + TOON

When working with information-dense JSON (LLM/OpenAPI schemas, API responses,
config dumps, datasets), prefer this pipeline over dumping raw JSON into context.
Use jaq first when it is available; jq is the fallback.

\`\`\`bash
curl -s <url> | jaq '<query>' | toon          # fetch → reshape → compress
cat data.json   | jaq '.items'  | toon --stats # local file, show token savings
echo "$TOON"    | toon -d                      # convert TOON back to JSON
\`\`\`

## Why
- **jaq** is the preferred jq-compatible query/reshape tool; it keeps only the
 slice you need and focuses on correctness, speed, and simplicity.
- **jq** is the fallback when jaq is not installed.
- **toon** re-encodes JSON as TOON: uniform arrays of objects declare their
 keys once (\`key[N]{a,b,c}:\`) then stream bare rows — large token savings on
 tabular/dense data. \`toon\` auto-detects direction; \`-d\` decodes back.

## When TOON helps (use it)
- Uniform/tabular arrays of objects (TOON's sweet spot — savings scale with rows × fields)
- Flat objects and primitive arrays
- Shallow nesting

## When to SKIP TOON (keep JSON)
- API-level contracts / payloads you must send or store verbatim
- Deeply nested or non-uniform structures (compact JSON can win)
- Arrays of arrays (TOON is less efficient here)
- Anything a downstream parser requires as strict JSON

Rule of thumb: TOON for **reading** dense data into context; JSON for **contracts**.
See the \`toon\` skill for the full workflow.`;

const JSON_TRIGGERS = ["json", "jsonl", "ndjson", "js", "jaq", "jq", "toon", "openapi", "swagger"] as const;
const JSON_TRIGGER_RE = new RegExp(`\\b(${JSON_TRIGGERS.join("|")})\\b`, "i");

export function mentionsJson(prompt: string | undefined | null): boolean {
	if (!prompt) return false;
	return JSON_TRIGGER_RE.test(prompt);
}

export interface ToonAdvice {
	useToon: boolean;
	reason: string;
}

export function adviseToon(value: unknown, maxDepth = 4): ToonAdvice {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return { useToon: false, reason: "empty array — nothing to compress" };
		}
		if (value.every((entry) => Array.isArray(entry))) {
			return { useToon: false, reason: "array of arrays — JSON is more compact" };
		}
		if (isUniformObjectArray(value)) {
			return {
				useToon: true,
				reason: `uniform array of ${value.length} objects — TOON tabular sweet spot`,
			};
		}
		if (value.every((entry) => !isObjectLike(entry))) {
			return { useToon: true, reason: "primitive array — TOON omits quotes/braces" };
		}
		return { useToon: false, reason: "non-uniform array — savings uncertain, keep JSON" };
	}

	if (isObjectLike(value)) {
		const depth = objectDepth(value);
		if (depth > maxDepth) {
			return {
				useToon: false,
				reason: `nesting depth ${depth} > ${maxDepth} — compact JSON may win`,
			};
		}
		return { useToon: true, reason: "shallow object — TOON drops quotes/braces" };
	}

	return { useToon: false, reason: "primitive value — nothing to compress" };
}

function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
	return typeof value === "object" && value !== null;
}

export function isUniformObjectArray(value: unknown[]): boolean {
	if (value.length === 0) return false;
	const first = value[0];
	if (!isPlainObject(first)) return false;
	const keys = Object.keys(first).sort();
	if (keys.length === 0) return false;

	return value.every((entry) => {
		if (!isPlainObject(entry)) return false;
		const entryKeys = Object.keys(entry).sort();
		if (entryKeys.length !== keys.length) return false;
		for (const key of keys) {
			if (!entryKeys.includes(key) || isObjectLike(entry[key])) return false;
		}
		return true;
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectDepth(value: unknown): number {
	if (!isObjectLike(value)) return 0;
	const children = Array.isArray(value) ? value : Object.values(value);
	let max = 0;
	for (const child of children) {
		const depth = objectDepth(child);
		if (depth > max) max = depth;
	}
	return max + 1;
}

function buildJsonSystemPrompt(queryCommand: QueryCommand): string {
	return `${JSON_SYSTEM_PROMPT}\n\nUse \`${queryCommand}\` for jq-compatible JSON queries in this environment.`;
}

function loadEnabledState(): boolean | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), STATE_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const enabled = (parsed as Record<string, unknown>).enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	} catch {
		return undefined;
	}
}

function saveEnabledState(enabled: boolean): void {
	try {
		const agentDir = getAgentDir();
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, STATE_FILE), `${JSON.stringify({ enabled }, null, "\t")}\n`, "utf8");
	} catch {
		// The toggle remains active for this session if the public agent directory is not writable.
	}
}

export default function toon(pi: ExtensionAPI): void {
	let enabled = loadEnabledState() ?? true;
	let queryCommand: QueryCommand | null | undefined;
	let toonAvailable: boolean | undefined;

	function syncStatus(ctx: Pick<ExtensionContext, "ui">): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, "TOON: off");
			return;
		}
		if (queryCommand === null || toonAvailable === false) {
			ctx.ui.setStatus(STATUS_KEY, "TOON: unavailable");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "TOON: on");
	}

	function stateMessage(): string {
		if (!enabled) return "TOON guidance is off.";
		if (queryCommand === null || toonAvailable === false)
			return "TOON guidance is on, but jaq/jq or toon is unavailable.";
		return "TOON guidance is on.";
	}

	async function isCommandAvailable(command: QueryCommand | "toon"): Promise<boolean> {
		try {
			return (await pi.exec("which", [command], { timeout: 1000 })).code === 0;
		} catch {
			return false;
		}
	}

	async function findQueryCommand(): Promise<QueryCommand | null> {
		if (await isCommandAvailable("jaq")) return "jaq";
		if (await isCommandAvailable("jq")) return "jq";
		return null;
	}

	pi.on("session_start", (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || !mentionsJson(event.prompt)) return undefined;

		if (queryCommand === undefined || toonAvailable === undefined) {
			[queryCommand, toonAvailable] = await Promise.all([findQueryCommand(), isCommandAvailable("toon")]);
			if (queryCommand === null) {
				ctx.ui.notify(
					"jaq and jq not found. Install jaq with: brew install jaq or cargo install --locked jaq; jq is the fallback.",
					"warning",
				);
			}
			if (!toonAvailable) {
				ctx.ui.notify("toon not found. Install it with: npm i -g @toon-format/cli", "warning");
			}
			syncStatus(ctx);
		}

		if (queryCommand === null || toonAvailable === false) return undefined;
		return { systemPrompt: `${buildJsonSystemPrompt(queryCommand)}\n\n${event.systemPrompt}` };
	});

	pi.registerCommand("toon", {
		description: "Toggle JSON/TOON guidance (on, off, or status)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const argument = args.trim().toLowerCase();
			if (argument === "status") {
				syncStatus(ctx);
				ctx.ui.notify(stateMessage(), "info");
				return;
			}

			const nextEnabled =
				argument === ""
					? !enabled
					: argument === "on" || argument === "enable"
						? true
						: argument === "off" || argument === "disable"
							? false
							: undefined;
			if (nextEnabled === undefined) {
				ctx.ui.notify("Usage: /toon [on|enable|off|disable|status]", "warning");
				return;
			}

			enabled = nextEnabled;
			saveEnabledState(enabled);
			syncStatus(ctx);
			ctx.ui.notify(`TOON guidance ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});
}
