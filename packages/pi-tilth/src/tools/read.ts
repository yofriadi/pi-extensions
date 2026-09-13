import { Type } from "typebox";
import { budgetParam, registerTilthTool, rootParam, type TilthToolDeps } from "../toolkit";

const DESCRIPTION =
	"Read a file with smart outlining. Replaces cat/head/tail and the host Read tool — use this for all file reading. Small files return full content. Large files return a structural outline (functions, classes, imports) so you see the shape without consuming your context window. Use `section` to read a specific line range or heading. Use `sections` to grab several disjoint slices from the same file in one call. Use `full` to force complete content. Use `paths` to read multiple files in one call.";

export function registerReadTool(pi: Parameters<typeof registerTilthTool>[0], deps: TilthToolDeps): void {
	registerTilthTool(pi, deps, {
		name: "tilth_read",
		label: "Tilth Read",
		description: DESCRIPTION,
		promptSnippet: "Smart file reading — full content, structural outlines, or targeted sections in one call.",
		promptGuidelines: [
			"Use tilth_read with `section` before editing a file — read the region you will edit, then edit.",
			"tilth_read outlines large files first so you can pick sections instead of reading everything.",
			"Complements the built-in read; use tilth_read when you want outlines/sections or token-capped output.",
		],
		// tilth_read is the only tool whose output is hashline-annotated.
		annotate: true,
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Absolute or relative file path to read. A relative path requires an absolute `root`; the server cannot see your shell cwd.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple file paths to read in one call. Each file gets independent smart handling. Saves round-trips vs multiple single reads.",
				}),
			),
			section: Type.Optional(
				Type.String({
					description:
						"Line range e.g. '45-89', or heading e.g. '## Architecture'. Bypasses smart view. Use `sections` for multiple ranges.",
				}),
			),
			sections: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 20,
					description:
						"Multiple ranges from the same file in one call. Each entry is a line range or heading. Emits each block in user-supplied order, separated by `─── lines X-Y ───` delimiters. Mutually exclusive with `section`. Capped at 20 ranges.",
				}),
			),
			mode: Type.Optional(
				Type.Union(
					[Type.Literal("auto"), Type.Literal("full"), Type.Literal("signature"), Type.Literal("stripped")],
					{
						default: "auto",
						description:
							"Read view. auto: smart default. full: full content. signature: hash-prefixed declarations only. stripped: whole-file content with plain comments/debug logs/extra blanks removed.",
					},
				),
			),
			full: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Legacy alias for mode='full'. Force full content output, bypass smart outlining.",
				}),
			),
			budget: budgetParam(),
			raw: Type.Optional(
				Type.Boolean({
					description:
						"Return plain text without hashline anchors (client-side; never sent to the server). Saves tokens when you will not edit this file — e.g. read-only sessions.",
				}),
			),
			root: rootParam(),
		}),
		renderCallText(args, theme) {
			const target =
				typeof args.path === "string" ? args.path : Array.isArray(args.paths) ? args.paths.join(", ") : "";
			const parts = [theme.fg("toolTitle", theme.bold("tilth_read"))];
			parts.push(theme.fg("accent", target));
			if (typeof args.section === "string") {
				parts.push(theme.fg("toolOutput", `§${args.section}`));
			}
			return parts.join(" ");
		},
		renderResultSummary(text, details, theme) {
			const header = text.split("\n")[0] ?? "";
			const icon = theme.fg("success", "✓");
			const lineCount = text.split("\n").length;
			const flag = details?.truncated ? theme.fg("warning", " [truncated]") : "";
			return `${icon} ${theme.fg("toolOutput", header.replace(/^# /, ""))} ${theme.fg("muted", `(${lineCount} lines)`)}${flag}`;
		},
	});
}
