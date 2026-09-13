import { Type } from "typebox";
import { registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

const DESCRIPTION =
	"Blast-radius check before breaking changes. Shows what a file imports (local + external) and what other files call its exports, with symbol-level detail. Use ONLY when your planned edit changes a function signature, removes/renames an export, or modifies behavior that callers rely on. Do NOT use for reading files, adding new code, or internal-only changes — use tilth_read instead.";

export function registerDepsTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_deps",
		label: "Tilth Deps",
		description: DESCRIPTION,
		promptSnippet: "Blast-radius check — imports and dependents of a file before breaking changes.",
		promptGuidelines: [
			"Run tilth_deps before renaming, removing, or changing an export's signature.",
			"Complements the built-in grep; tilth_deps answers 'what depends on this file' structurally.",
		],
		// Search-root tool: omitted scope must anchor to the session cwd (the
		// server would otherwise search its own process cwd).
		defaultScope: true,
		parameters: Type.Object({
			path: Type.String({
				description: "File to check before making breaking changes.",
			}),
			scope: Type.Optional(
				Type.String({
					description: "Directory to search for dependents. Default: project root.",
				}),
			),
			budget: Type.Optional(
				Type.Number({
					description: "Max tokens. Truncates 'Used by' first.",
				}),
			),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const parts = [theme.fg("toolTitle", theme.bold("tilth_deps"))];
			parts.push(theme.fg("accent", String(args.path)));
			return parts.join(" ");
		},
		renderResultSummary(text, _details, theme) {
			const header = text.split("\n")[0] ?? "";
			return `${theme.fg("success", "✓")} ${theme.fg("toolOutput", header.replace(/^# /, ""))}`;
		},
	});
}
