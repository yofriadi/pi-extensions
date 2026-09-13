import { Type } from "typebox";
import { budgetParam, registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

const DESCRIPTION =
	"List files matching glob patterns as a directory tree. Replaces find/ls/tree and the host Glob tool — use this to see project structure with per-directory token-size rollups. Pass `patterns` to combine several globs into one tree.";

export function registerListTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_list",
		label: "Tilth List",
		description: DESCRIPTION,
		promptSnippet: "Directory tree with per-directory token-size rollups for glob patterns.",
		promptGuidelines: [
			"Use tilth_list to see project structure with token rollups before deciding what to read.",
			"Complements the built-in ls/glob; prefer tilth_list when size context matters.",
		],
		// Search-root tool: omitted scope must anchor to the session cwd (the
		// server would otherwise search its own process cwd).
		defaultScope: true,
		parameters: Type.Object({
			patterns: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 20,
				description: "Glob patterns rendered into one tree, e.g. ['*.rs'] or ['*.rs', '*.toml']. Capped at 20.",
			}),
			scope: Type.Optional(
				Type.String({
					description:
						"Directory to root the tree at. DO NOT USE scope if you want to list the current working directory.",
				}),
			),
			depth: Type.Optional(
				Type.Number({
					description: "Cap directory depth (1 = top-level only).",
				}),
			),
			budget: budgetParam(),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const patterns = Array.isArray(args.patterns) ? args.patterns.join(", ") : "";
			const scope = typeof args.scope === "string" ? args.scope : ".";
			const parts = [theme.fg("toolTitle", theme.bold("tilth_list"))];
			parts.push(theme.fg("accent", `${patterns} in ${scope}`));
			return parts.join(" ");
		},
		renderResultSummary(_text, _details, theme) {
			return `${theme.fg("success", "✓")} ${theme.fg("muted", "tree ready")}`;
		},
	});
}
