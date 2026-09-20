/**
 * Derives the Perch Starter-pool model catalog from the locally installed
 * `perchai-cli` bundle and the published docs pool table.
 *
 * Docs (`https://www.perchai.app/docs/concepts/models`) are the *pool* truth:
 * which models a free Starter account can run. The CLI bundle is the
 * *pin/context* truth: the `manualModelOptionId` strings, context windows,
 * max output tokens, and reasoning flags the server actually accepts. When
 * the two disagree (Perch rotates the pool between CLI releases), the docs
 * win and the bundle must supply a matching pin — otherwise the script fails
 * loudly rather than registering a dead pin.
 *
 * Emits:
 *  - `src/models.generated.ts` — pin + context + reasoning per docs model
 *  - `src/cli-version.ts`      — the `perchai-cli/<version>` user agent
 *
 * Run: `pnpm run discover-models`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_URL = "https://www.perchai.app/docs/concepts/models";

interface RegistryEntry {
	pin: string;
	providerId: string;
	modelId: string;
	label: string;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	reasoning: boolean;
	userFacing: boolean;
}

interface DocsModel {
	displayName: string;
}

interface GeneratedModel extends RegistryEntry {
	bareId: string;
	displayName: string;
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Reviewed fallback pins for docs-listed Starter models that the CLI's current
 * Starter-alias table omits. Every value must still resolve to a parsed bundle
 * registry entry; unknown/dead overrides fail generation rather than emit.
 */
const STARTER_PIN_OVERRIDES: Readonly<Record<string, string>> = {
	"qwen-3.6": "wandb-qwen3-6-35b-a3b",
	"glm-5": "bedrock-mantle-zai-glm-5",
	"qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
	"nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
	"gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
	"gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
};

function fail(message: string): never {
	console.error(`discover-models: ${message}`);
	process.exit(1);
}

/** Regex form of the CLI's `Ks(providerId, modelId)` pin builder. */
function ksPin(providerId: string, modelId: string): string {
	const provider = providerId.replace(/_/g, "-");
	const model = modelId
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return `${provider}-${model}`;
}

/** Locates `perchai-cli/dist/perch.mjs`: npm global root first, then pnpm's global store. */
function findBundle(): { bundlePath: string; version: string } {
	const candidates: { bundlePath: string; version: string }[] = [];
	const seen = new Set<string>();
	const probe = (pkgDir: string): void => {
		const pkgJson = join(pkgDir, "package.json");
		const bundlePath = join(pkgDir, "dist/perch.mjs");
		if (seen.has(bundlePath) || !existsSync(pkgJson) || !existsSync(bundlePath)) {
			return;
		}
		try {
			const version = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version;
			if (typeof version === "string" && version.length > 0) {
				seen.add(bundlePath);
				candidates.push({ bundlePath, version });
			}
		} catch {
			// unparseable package.json: skip this install
		}
	};

	// npm global (`npm root -g`): <root>/perchai-cli
	try {
		const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		if (npmRoot.length > 0) {
			probe(join(npmRoot, "perchai-cli"));
		}
	} catch {
		// npm not on PATH: fall through to the pnpm store scan
	}

	// pnpm global store: ~/.local/share/pnpm/global/v11/<hash>/node_modules/perchai-cli
	const pnpmGlobalDir = join(homedir(), ".local/share/pnpm/global/v11");
	if (existsSync(pnpmGlobalDir)) {
		for (const entry of readdirSync(pnpmGlobalDir)) {
			probe(join(pnpmGlobalDir, entry, "node_modules/perchai-cli"));
		}
	}

	if (candidates.length === 0) {
		fail(
			"no perchai-cli install with dist/perch.mjs found (npm root -g or pnpm global); install perchai-cli first",
		);
	}
	// Newest bundle wins when several global installs exist.
	candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
	return candidates[0];
}

/** Evaluates the bundle's minified numeric literals (`128e3`, `262144`, `1e6`). */
function evalNumber(token: string): number | null {
	return /^-?\d+(\.\d+)?(e\d+)?$/i.test(token) ? Number(token) : null;
}

/** Reads a `name:"value"` or `name:!0` field from one registry entry body. */
function rawField(fields: string, name: string): string | null {
	const match = new RegExp(`\\b${name}:("(?:[^"\\\\]|\\\\.)*"|[^,}]+)`).exec(fields);
	return match === null ? null : match[1];
}

/** String field, decoding the bundle's `\xB7`-style escapes. */
function readString(fields: string, name: string): string | null {
	const raw = rawField(fields, name);
	if (raw === null) return null;
	if (!raw.startsWith('"')) return raw;
	try {
		// Bundle uses \xNN escapes; JSON.parse only accepts \uNNNN.
		return JSON.parse(raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")) as string;
	} catch {
		return raw.slice(1, -1);
	}
}

function readNumber(fields: string, name: string): number | null {
	const raw = rawField(fields, name);
	if (raw === null) return null;
	if (raw === "!0") return 1;
	if (raw === "!1") return 0;
	return evalNumber(raw);
}

/**
 * Resolves the bundle's pin consts: plain slug strings plus
 * `Ks("providerId","modelId")` aliases (regex form of the CLI's pin builder).
 */
function extractConsts(region: string): Map<string, string> {
	const consts = new Map<string, string>();
	// Pin-builder aliases: `XX("providerId","modelId")` where XX is the
	// minified pin-builder fn (Ks in 2.4.100, ks in 2.4.101 — renamed across
	// minifier runs, so match any short identifier, not a literal name).
	for (const match of region.matchAll(
		/([A-Za-z_$][A-Za-z0-9_$]{0,3})=[A-Za-z_$][A-Za-z0-9_$]*\("([^"]+)","([^"]+)"\)/g,
	)) {
		consts.set(match[1], ksPin(match[2], match[3]));
	}
	for (const match of region.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)="([^"]*)"/g)) {
		if (!consts.has(match[1])) consts.set(match[1], match[2]);
	}
	return consts;
}

/** Replaces identifier values with their resolved pin strings. */
function resolveIdentifiers(aliases: Map<string, string>, consts: Map<string, string>): Map<string, string> {
	const resolved = new Map<string, string>();
	for (const [bareId, value] of aliases) {
		const pin = consts.get(value) ?? value;
		resolved.set(bareId, pin);
	}
	return resolved;
}

/**
 * Extracts pricing records (pin truth) and joins their model coordinates to
 * richer registry records (context/output/reasoning truth). Bundle helper and
 * table names are minified differently between releases, so matching is based
 * on the stable object fields rather than identifier names.
 */
function extractRegistry(bundleText: string): { entries: RegistryEntry[]; consts: Map<string, string> } {
	// Resolve bundle-wide pin constants first. Pricing records carry the accepted
	// pin in modelOptionId; registry records carry the richer model metadata.
	const consts = extractConsts(bundleText);
	const objectRe = /\{((?:[^{}]|\{[^{}]*\})*?providerId:\s*"[^"]+"(?:[^{}]|\{[^{}]*\})*?)\}/g;
	const records = [...bundleText.matchAll(objectRe)].map((match) => match[1]);
	if (records.length === 0) {
		fail("no registry entries parsed from the bundle; bundle layout changed?");
	}

	const metadataByModel = new Map<string, Omit<RegistryEntry, "pin">>();
	for (const fields of records) {
		const providerId = readString(fields, "providerId");
		const modelId = readString(fields, "modelId");
		if (providerId === null || modelId === null || readString(fields, "modelOptionId") !== null) continue;
		const key = `${providerId}\u0000${modelId}`;
		const existing = metadataByModel.get(key);
		const contextWindow = readNumber(fields, "contextWindow");
		const maxOutputTokens = readNumber(fields, "maxOutputTokens");
		const reasoningSupport = readString(fields, "reasoningSupport");
		const userFacing = readString(fields, "userFacing");
		metadataByModel.set(key, {
			providerId,
			modelId,
			label: readString(fields, "label") ?? existing?.label ?? modelId,
			contextWindow: contextWindow ?? existing?.contextWindow ?? null,
			maxOutputTokens: maxOutputTokens ?? existing?.maxOutputTokens ?? null,
			reasoning: reasoningSupport === null ? (existing?.reasoning ?? false) : reasoningSupport === "true",
			userFacing: userFacing === null ? (existing?.userFacing ?? false) : userFacing === "!0",
		});
	}

	const byPin = new Map<string, RegistryEntry>();
	for (const fields of records) {
		const providerId = readString(fields, "providerId");
		const modelId = readString(fields, "modelId");
		const modelOptionId = readString(fields, "modelOptionId");
		if (providerId === null || modelId === null || modelOptionId === null) continue;
		const pin = consts.get(modelOptionId) ?? modelOptionId;
		const metadata = metadataByModel.get(`${providerId}\u0000${modelId}`);
		byPin.set(pin, {
			pin,
			providerId,
			modelId,
			label: metadata?.label ?? readString(fields, "label") ?? modelId,
			contextWindow: metadata?.contextWindow ?? readNumber(fields, "contextWindow"),
			maxOutputTokens: metadata?.maxOutputTokens ?? readNumber(fields, "maxOutputTokens"),
			reasoning: metadata?.reasoning ?? readString(fields, "reasoningSupport") === "true",
			userFacing: metadata?.userFacing ?? readString(fields, "userFacing") === "!0",
		});
	}
	if (byPin.size === 0) {
		fail("no modelOptionId registry entries parsed from the bundle; bundle layout changed?");
	}
	return { entries: [...byPin.values()], consts };
}

/** Bare pi id -> pin identifier, from the bundle's starter-alias tables. */
function extractStarterAliases(bundleText: string, consts: Map<string, string>): Map<string, string> {
	// Alias tables map a bare id to a pin const: `XX={"bare-id":PIN,...}`.
	// The table var is renamed per minifier run (m3/J7/$mt in 2.4.101), so we
	// match any `{"bare-id":<ident>,...}` literal whose keys are slug-shaped.
	const aliases = new Map<string, string>();
	const tableRe =
		/\{((?:"[a-z0-9][a-z0-9.-]*":[A-Za-z_$][A-Za-z0-9_$]*)(?:,"[a-z0-9][a-z0-9.-]*":[A-Za-z_$][A-Za-z0-9_$]*)*)\}/g;
	for (const match of bundleText.matchAll(tableRe)) {
		for (const pair of match[1].matchAll(/"([a-z0-9][a-z0-9.-]*)":([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
			// Only keep entries whose value resolves to a known pin const.
			if (consts.has(pair[2])) {
				aliases.set(pair[1], pair[2]);
			}
		}
	}
	if (aliases.size === 0) {
		fail("bundle layout changed: no starter-alias tables parsed");
	}
	return resolveIdentifiers(aliases, consts);
}

/** Bundle display names (bare id -> "Qwen 3.6"). */
function extractDisplayNames(bundleText: string): Map<string, string> {
	// The display-name table maps bare ids to human labels:
	// `XX={"gpt-5.6-luna":"GPT-5.6 Luna","qwen-3.6":"Qwen 3.6",...}`. The table
	// var is renamed per minifier run (CEe in 2.4.100, BEe in 2.4.101), so we
	// match any run of `"bare-id":"Display Name"` pairs (some trailing keys are
	// unquoted, so we scan pair-runs rather than a whole `{...}` literal). We keep
	// the run with the most pairs — that is the model display-name table.
	const pairRe = /"([a-z0-9][a-z0-9.-]*)":"([^"]+)"/g;
	let best = new Map<string, string>();
	let run = new Map<string, string>();
	let lastEnd = -2;
	for (const match of bundleText.matchAll(pairRe)) {
		// A pair continues the current run only if it immediately follows the last.
		const gap = bundleText.slice(lastEnd, match.index);
		if (!/^,?$/.test(gap)) {
			if (run.size > best.size) {
				best = run;
			}
			run = new Map<string, string>();
		}
		run.set(match[1], match[2]);
		lastEnd = (match.index ?? 0) + match[0].length;
	}
	if (run.size > best.size) {
		best = run;
	}
	if (best.size < 3) {
		fail("bundle layout changed: no display-name table parsed");
	}
	return best;
}

/** Scrapes the docs page's Starter pool table (docs truth). */
async function fetchDocsPool(): Promise<DocsModel[]> {
	const response = await fetch(DOCS_URL, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		fail(`docs fetch failed: ${response.status} ${DOCS_URL}`);
	}
	const html = await response.text();
	const start = html.indexOf('id="starter"');
	const end = html.indexOf('id="pro"', start);
	if (start === -1 || end === -1) {
		fail(`docs page no longer has Starter/Pro sections; update the scraper for ${DOCS_URL}`);
	}
	const section = html.slice(start, end);
	const rows = [...section.matchAll(/<tr><td>(.*?)<\/td>/g)].map((m) => stripTags(m[1]));
	const models = rows.filter((name) => name.length > 0);
	if (models.length === 0) {
		fail(`no Starter pool rows found on ${DOCS_URL}; Perch may have redesigned the page`);
	}
	return models.map((displayName) => ({ displayName }));
}

function stripTags(cell: string): string {
	return cell.replace(/<[^>]+>/g, "").trim();
}

/** Maps a docs display name to the bundle's bare id via the CEe table. */
function canonicalBareId(docsModel: DocsModel, displayNames: Map<string, string>): string | null {
	for (const [bareId, displayName] of displayNames) {
		if (displayName === docsModel.displayName) return bareId;
	}
	return null;
}

function emitFiles(bundleVersion: string, bundleDate: string, generated: GeneratedModel[]): void {
	const header = [
		"/**",
		" * GENERATED by scripts/discover-models.ts — DO NOT EDIT BY HAND.",
		` * Derived from perchai-cli@${bundleVersion} (dist/perch.mjs, read ${bundleDate})`,
		` * cross-referenced against the Starter pool at ${DOCS_URL} (docs = pool truth).`,
		" */",
	].join("\n");

	const modelsFile = `${header}
/** Bare pi model id -> Starter-pool pin and registry facts. */
export interface GeneratedPerchModel {
	pin: string;
	displayName: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
}

export const PERCH_MODEL_PINS: Record<string, GeneratedPerchModel> = {
${generated
	.map(
		(model) =>
			`\t"${model.bareId}": {\n\t\tpin: "${model.pin}",\n\t\tdisplayName: "${model.displayName}",\n\t\tcontextWindow: ${model.contextWindow},\n\t\tmaxOutputTokens: ${model.maxOutputTokens},\n\t\treasoning: ${model.reasoning},\n\t},`,
	)
	.join("\n")}
};
`;
	writeFileSync(join(packageDir, "src/models.generated.ts"), modelsFile);

	const versionFile = `${header}
/** User agent the Perch server gates on (client_update_required). */
export const PERCH_CLI_VERSION = "${bundleVersion}";
export const PERCH_CLI_UA = \`perchai-cli/${bundleVersion}\`;
`;
	writeFileSync(join(packageDir, "src/cli-version.ts"), versionFile);

	console.log(`discover-models: wrote src/models.generated.ts (${generated.length} models)`);
	for (const model of generated) {
		console.log(
			`  perch/${model.bareId.padEnd(14)} pin=${model.pin.padEnd(46)} ctx=${model.contextWindow} out=${model.maxOutputTokens} reasoning=${model.reasoning}`,
		);
	}
	console.log(`discover-models: wrote src/cli-version.ts (perchai-cli/${bundleVersion})`);
}

async function main(): Promise<void> {
	const { bundlePath, version } = findBundle();
	console.log(`discover-models: bundle ${bundlePath} (perchai-cli@${version})`);
	const bundleDate = statSync(bundlePath).mtime.toISOString().slice(0, 10);
	const bundleText = readFileSync(bundlePath, "utf8");

	const { entries: registry, consts } = extractRegistry(bundleText);
	const byPin = new Map(registry.map((entry) => [entry.pin, entry]));
	const starterAliases = extractStarterAliases(bundleText, consts);
	const displayNames = extractDisplayNames(bundleText);
	const docsPool = await fetchDocsPool();

	// Cross-reference by exact docs/display-table names. The display table supplies
	// the stable bare id; an explicit CLI starter alias wins. Reviewed overrides
	// fill only models the current alias table omits, and must name a live parsed
	// registry pin or generation fails loudly.
	const generated: GeneratedModel[] = [];
	const missing: string[] = [];
	for (const docsModel of docsPool) {
		const bareId = canonicalBareId(docsModel, displayNames);
		if (bareId === null) {
			missing.push(`${docsModel.displayName} (no exact display-name match in bundle)`);
			continue;
		}
		const alias = starterAliases.get(bareId);
		const override = STARTER_PIN_OVERRIDES[bareId];
		const pin = alias ?? override;
		const entry = pin !== undefined ? byPin.get(pin) : undefined;
		if (entry === undefined) {
			const detail = pin === undefined ? "no CLI alias or reviewed override" : `pin ${pin} absent from registry`;
			missing.push(`${docsModel.displayName} (${bareId}: ${detail})`);
			continue;
		}
		generated.push({
			...entry,
			bareId,
			displayName: displayNames.get(bareId) ?? docsModel.displayName,
			// Conservative defaults when the bundle is silent (design: 131072/8192).
			contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxOutputTokens: entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		});
	}
	if (missing.length > 0) {
		fail(
			`docs Starter model(s) without a verified bundle pin: ${missing.join("; ")}. ` +
				"Upgrade perchai-cli and/or review STARTER_PIN_OVERRIDES; refusing to emit a dead pin.",
		);
	}
	if (generated.length === 0) {
		fail("cross-reference produced no models");
	}

	emitFiles(version, bundleDate, generated);
}

await main();
