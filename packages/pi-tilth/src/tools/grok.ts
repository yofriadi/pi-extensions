import { Type } from "typebox";
import { registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

const DESCRIPTION =
	"Get everything structural about a symbol in one call — definition, body, signature, doc, callees, callers, siblings, tests. Use ONLY for 'understand this symbol' questions. Do NOT use for concept search (use tilth_search) or reading file contents (use tilth_read).";

export function registerGrokTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_grok",
		label: "Tilth Grok",
		description: DESCRIPTION,
		promptSnippet: "One-call symbol deep-dive: definition, body, callees, callers, siblings, tests.",
		promptGuidelines: [
			"Use tilth_grok when you need everything about one symbol; use tilth_search for broad questions.",
			"Complements the built-in read/grep; tilth_grok assembles the symbol's neighborhood for you.",
		],
		// Search-root tool: omitted scope must anchor to the session cwd (the
		// server would otherwise search its own process cwd).
		defaultScope: true,
		parameters: Type.Object({
			target: Type.String({
				description:
					"Symbol name, e.g. 'parse_unified_diff'. Also accepts 'src/diff/parse.rs:7' or 'Type::method'.",
			}),
			scope: Type.Optional(
				Type.String({
					description: "Subdirectory to narrow the search. Default: project root.",
				}),
			),
			full: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Widen caps: 50 callers, 30 callees, 30 siblings, 30 tests (default 5/5/8/8).",
				}),
			),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const parts = [theme.fg("toolTitle", theme.bold("tilth_grok"))];
			parts.push(theme.fg("accent", String(args.target)));
			return parts.join(" ");
		},
		renderResultSummary(text, _details, theme) {
			const header = text.split("\n")[0] ?? "";
			return `${theme.fg("success", "✓")} ${theme.fg("toolOutput", header.replace(/^# /, ""))}`;
		},
	});
}
