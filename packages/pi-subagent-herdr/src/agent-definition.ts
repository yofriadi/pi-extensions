import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SeedMode = "fresh" | "fork";

export interface AgentDefinition {
	id: string;
	sourcePath: string;
	source: "project" | "global";
	model?: string;
	thinking?: string;
	tools: string;
	skills?: string;
	seed: SeedMode;
	body: string;
	/** Original frontmatter is retained so other extensions remain its consumers. */
	frontmatter: string;
}

const CANONICAL_AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;

export class AgentDefinitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentDefinitionError";
	}
}

export function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function validateCanonicalAgentId(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new AgentDefinitionError("Subagent agent is required.");
	}
	if (value !== value.trim() || !CANONICAL_AGENT_ID.test(value)) {
		throw new AgentDefinitionError(`Invalid subagent agent ${JSON.stringify(value)}.`);
	}
	return value;
}

/**
 * Focused frontmatter scalar parser for the owned agent-definition subset.
 *
 * Pi agent definitions use flat `key: value` scalars for the fields this
 * extension owns (name, model, thinking, tools, skills, seed). Values may be
 * quoted and carry trailing inline comments — both of which a naive line regex
 * gets wrong (e.g. `seed: fresh # fork from parent` yields `fresh # ...`, and
 * `name: "reviewer"` keeps the quotes). This parser strips comments outside
 * quotes, unquotes scalars, and ignores indented nested blocks (such as
 * `permission:`) which are retained verbatim via the raw `frontmatter` string.
 */
type FrontmatterScalars = Record<string, string | null>;

function stripInlineComment(value: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
			return value.slice(0, i);
		}
	}
	return value;
}

/** Unquote a YAML-style scalar. Single-quoted scalars collapse doubled single
 * quotes (`''` → `'`); double-quoted scalars decode `\"` and `\\` and reject
 * any other backslash escape so model/skill values are not silently changed. */
function unquoteScalar(value: string): string | null {
	const v = value.trim();
	if (v === "" || v === "null" || v === "~" || /^(?:null|Null|NULL|~)$/.test(v)) return null;
	const first = v[0];
	if (first === '"' || first === "'") {
		if (v.length >= 2 && v.at(-1) === first) {
			const inner = v.slice(1, -1);
			if (first === '"') {
				if (/\\(?!["\\])/g.test(inner)) {
					throw new AgentDefinitionError(
						`Invalid agent frontmatter: unsupported escape in double-quoted scalar ${JSON.stringify(value)}.`,
					);
				}
				return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			}
			return inner.replace(/''/g, "'");
		}
		return v;
	}
	return v;
}

function parseFrontmatterScalars(frontmatter: string): FrontmatterScalars {
	const result: FrontmatterScalars = {};
	for (const rawLine of frontmatter.split("\n")) {
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
		// Only non-indented lines are top-level owned scalars; nested mappings
		// (e.g. `permission:`) are skipped here and preserved via raw frontmatter.
		if (/^\s/.test(rawLine)) continue;
		const colon = rawLine.indexOf(":");
		if (colon === -1) continue;
		const key = rawLine.slice(0, colon).trim();
		if (!key) continue;
		result[key] = unquoteScalar(stripInlineComment(rawLine.slice(colon + 1)).trim());
	}
	return result;
}

/** Extract an owned string scalar, treating null/empty as omitted. */
function scalarString(value: string | null | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed;
}

/**
 * Reject embedded canonical identity tags in the definition body so prompt
 * assembly always emits exactly one `<active_agent>` tag. A body that
 * smuggles its own identity tag could create ambiguous downstream permission
 * identity.
 */
function rejectIdentityTagsInBody(body: string, id: string): void {
	if (/<active_agent\b/i.test(body)) {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(id)}: body must not contain an <active_agent> identity tag.`,
		);
	}
}

export function validateToolsProfile(value: unknown, agentId = "subagent"): string {
	if (typeof value !== "string") {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(agentId)}: tools must be a non-empty string.`,
		);
	}
	let normalized = value.trim();
	if (!normalized) {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(agentId)}: tools must be a non-empty string.`,
		);
	}
	const quote = normalized[0];
	if (quote === '"' || quote === "'") {
		if (normalized.length < 2 || normalized.at(-1) !== quote) {
			throw new AgentDefinitionError(
				`Invalid subagent ${JSON.stringify(agentId)}: tools must be a valid string.`,
			);
		}
		normalized = normalized.slice(1, -1).trim();
	} else if (
		/^(?:null|undefined|true|false|~)$/i.test(normalized) ||
		/^[-+]?\d+(?:\.\d+)?$/.test(normalized) ||
		normalized.startsWith("[") ||
		normalized.startsWith("{")
	) {
		throw new AgentDefinitionError(`Invalid subagent ${JSON.stringify(agentId)}: tools must be a string.`);
	}
	if (!normalized) {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(agentId)}: tools must be a non-empty string.`,
		);
	}
	const names = normalized.split(",").map((tool) => tool.trim());
	if (names.some((tool) => tool === "")) {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(agentId)}: tools must not contain empty entries.`,
		);
	}
	if (names.some((tool) => tool !== "*" && !/^[A-Za-z0-9_.:-]+$/.test(tool))) {
		throw new AgentDefinitionError(
			`Invalid subagent ${JSON.stringify(agentId)}: tools contain an invalid tool name.`,
		);
	}
	return names.join(",");
}

export function parseAgentDefinition(
	content: string,
	id: string,
	sourcePath: string,
	source: AgentDefinition["source"] = "global",
): AgentDefinition {
	validateCanonicalAgentId(id);
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new AgentDefinitionError(`Invalid subagent ${JSON.stringify(id)}.`);

	const frontmatter = match[1];
	const scalars = parseFrontmatterScalars(frontmatter);
	if (scalars["system-prompt"] !== undefined) {
		throw new AgentDefinitionError(`Invalid subagent ${JSON.stringify(id)}: obsolete system-prompt frontmatter.`);
	}

	const assertedName = scalarString(scalars["name"]);
	if (assertedName !== undefined && assertedName !== id) {
		throw new AgentDefinitionError(`Invalid subagent ${JSON.stringify(id)}: frontmatter name must match filename.`);
	}

	const seedValue = scalarString(scalars["seed"]);
	if (seedValue !== undefined && seedValue !== "fresh" && seedValue !== "fork") {
		throw new AgentDefinitionError(`Invalid subagent ${JSON.stringify(id)}: seed must be fresh or fork.`);
	}

	const tools = validateToolsProfile(scalars["tools"], id);

	const body = content.slice(match[0].length).trim();
	rejectIdentityTagsInBody(body, id);

	return {
		id,
		sourcePath,
		source,
		model: scalarString(scalars["model"]),
		thinking: scalarString(scalars["thinking"]),
		tools,
		skills: scalarString(scalars["skills"]),
		seed: (seedValue as SeedMode | undefined) ?? "fresh",
		body,
		frontmatter,
	};
}

export function loadAgentDefinition(options: {
	id: unknown;
	cwd: string;
	agentDir?: string;
	projectTrusted: boolean;
}): AgentDefinition {
	const id = validateCanonicalAgentId(options.id);
	const candidates: Array<{ path: string; source: AgentDefinition["source"] }> = [];
	if (options.projectTrusted) {
		candidates.push({ path: join(options.cwd, ".pi", "agents", `${id}.md`), source: "project" });
	}
	candidates.push({
		path: join(options.agentDir ?? getAgentConfigDir(), "agents", `${id}.md`),
		source: "global",
	});

	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		return parseAgentDefinition(readFileSync(candidate.path, "utf8"), id, candidate.path, candidate.source);
	}
	throw new AgentDefinitionError(`Unknown subagent ${JSON.stringify(id)}.`);
}
