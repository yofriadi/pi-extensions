import { Type } from "typebox";
import { budgetParam, registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

const DESCRIPTION =
	"Structural diff showing function-level changes. Replaces git diff. Call with no args for uncommitted changes overview.";

export function registerDiffTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_diff",
		label: "Tilth Diff",
		description: DESCRIPTION,
		promptSnippet: "Structural diff with function-level change summaries and blast-radius warnings.",
		promptGuidelines: [
			"Use tilth_diff for symbol-level review of changes; use git diff for raw patch text.",
			"tilth_diff with no args summarizes uncommitted changes; add expand=N to inline changed sources.",
		],
		parameters: Type.Object({
			a: Type.Optional(
				Type.String({
					description: "First file for a file-to-file diff. Must be used together with b.",
				}),
			),
			b: Type.Optional(
				Type.String({
					description: "Second file for a file-to-file diff. Must be used together with a.",
				}),
			),
			source: Type.Optional(
				Type.String({
					description:
						"Diff source: 'uncommitted' (default), 'staged', or a git ref (e.g. 'HEAD~1', 'main..feat'). Ignored when a, b, patch, or log is set.",
				}),
			),
			log: Type.Optional(
				Type.String({
					description: "Git log range (e.g. 'HEAD~5..HEAD') — shows per-commit structural summaries.",
				}),
			),
			patch: Type.Optional(
				Type.String({
					description: "Path to a .patch file to parse instead of running git diff.",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description: "Restrict diff output to a specific file or directory path.",
				}),
			),
			search: Type.Optional(
				Type.String({
					description: "Filter output to symbols or files matching this substring (case-insensitive).",
				}),
			),
			expand: Type.Optional(
				Type.Number({
					default: 0,
					description: "Number of changed symbols to expand with full source context.",
				}),
			),
			blast: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Show blast-radius warnings for signature-changed symbols.",
				}),
			),
			budget: budgetParam(),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const parts = [theme.fg("toolTitle", theme.bold("tilth_diff"))];
			if (typeof args.a === "string" && typeof args.b === "string") {
				parts.push(theme.fg("accent", `${args.a} ↔ ${args.b}`));
			} else if (typeof args.log === "string") {
				parts.push(theme.fg("accent", `log ${args.log}`));
			} else {
				parts.push(theme.fg("accent", typeof args.source === "string" ? args.source : "uncommitted"));
			}
			return parts.join(" ");
		},
		renderResultSummary(text, _details, theme) {
			const header = text.split("\n")[0] ?? "";
			return `${theme.fg("success", "✓")} ${theme.fg("toolOutput", header.replace(/^# /, ""))}`;
		},
	});
}
