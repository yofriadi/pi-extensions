import { Type } from "typebox";
import { budgetParam, registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

// Verbatim transcription of the server's tilth_search description
// (test/fixtures/tilth-server-schema.json). These descriptions are
// benchmark-tuned; paraphrasing them forfeits measured behavior.
const DESCRIPTION =
	"Search for symbols, text, or regex patterns in code. Replaces grep/rg and the host Grep tool — use this for all code search. Symbol search returns definitions first (via tree-sitter AST), then usages, with full source code inlined for top matches. Content search finds literal text. Regex search supports full regex patterns. For cross-file tracing, pass comma-separated symbol names (max 5).";

export function registerSearchTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_search",
		label: "Tilth Search",
		description: DESCRIPTION,
		promptSnippet:
			"Structural code search — symbol definitions/usages with source inlined, callers, content and regex modes.",
		promptGuidelines: [
			"Use tilth_search before tilth_read: search returns definitions, usages, and caller footers in one call.",
			"tilth_search kind=symbol is tree-sitter aware — prefer it over text greps for symbol tracing.",
			"Complements the built-in grep; neither replaces the other — choose per query (structural vs exact pattern).",
		],
		// Search-root tool: omitted scope must anchor to the session cwd (the
		// server would otherwise search its own process cwd).
		defaultScope: true,
		parameters: Type.Object({
			query: Type.String({
				description:
					"Symbol name, text string, or regex pattern to search for. e.g. 'resolve_dependencies' or 'ServeHTTP,Next' for comma-separated multi-symbol lookup (max 5).",
			}),
			kind: Type.Optional(
				Type.Union(
					[Type.Literal("symbol"), Type.Literal("content"), Type.Literal("regex"), Type.Literal("callers")],
					{
						default: "symbol",
						description:
							"Search type. symbol: structural definitions + usages. content: literal text. regex: regex pattern. callers: find all call sites of a symbol.",
					},
				),
			),
			scope: Type.Optional(
				Type.String({
					description:
						"Only use scope to search a specific subdirectory. DO NOT USE scope if you want to search the current working directory (initial search).",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description:
						'File pattern filter. Whitelist: "*.rs" (only Rust files). Exclude: "!*.test.ts" (skip test files). Brace expansion: "*.{go,rs}" (Go and Rust). Path patterns: "src/**/*.ts".',
				}),
			),
			expand: Type.Optional(
				Type.Number({
					default: 2,
					description:
						"Number of top matches to expand with full source code. Definitions show the full function/class body. Usages show ±10 context lines.",
				}),
			),
			context: Type.Optional(
				Type.String({
					description:
						"Path to the file the agent is currently editing. Boosts ranking of matches in the same directory or package.",
				}),
			),
			budget: budgetParam(),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const kind = typeof args.kind === "string" ? args.kind : "symbol";
			const scope = typeof args.scope === "string" ? args.scope : ".";
			const parts = [theme.fg("toolTitle", theme.bold("tilth_search"))];
			parts.push(theme.fg("accent", `"${String(args.query)}"`));
			parts.push(theme.fg("toolOutput", `(${kind}) in ${scope}`));
			return parts.join(" ");
		},
		renderResultSummary(text, _details, theme) {
			const header = text.split("\n")[0] ?? "";
			const icon = theme.fg("success", "✓");
			return `${icon} ${theme.fg("toolOutput", header.replace(/^# /, ""))}`;
		},
	});
}
