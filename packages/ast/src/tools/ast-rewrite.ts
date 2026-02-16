import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "../utils/exec.js";

const MAX_OUTPUT_LENGTH = 10000;

export function registerAstRewrite(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast_rewrite",
		label: "AST Rewrite",
		description:
			"Search and rewrite code using AST patterns with ast-grep (sg). Defaults to dry-run (preview). Use `apply: true` to execute changes.",
		parameters: Type.Object({
			pattern: Type.String({ description: "AST pattern to search for" }),
			rewrite: Type.String({ description: "Replacement pattern" }),
			path: Type.Optional(Type.String({ description: "File or directory to search in" })),
			lang: Type.Optional(Type.String({ description: "Language to use for parsing" })),
			apply: Type.Optional(Type.Boolean({ description: "Apply changes if true. Defaults to false (dry-run)." })),
		}),
		execute: async (_toolCallId, params) => {
			const { pattern, rewrite, path, lang, apply } = params;

			try {
				const args = ["sg", "run", "--pattern", pattern, "--rewrite", rewrite, "--color=never"];

				if (lang) {
					args.push("--lang", lang);
				}

				if (apply) {
					args.push("-U"); // Update all (apply)
				}

				// Add path at the end
				if (path) {
					args.push(path);
				}

				const { exitCode, stdout, stderr } = await exec(args);

				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: `ast-rewrite failed: ${stderr}` }],
						isError: true,
						details: undefined,
					};
				}

				if (!stdout.trim()) {
					return {
						content: [{ type: "text", text: apply ? "No changes applied (no matches found)." : "No matches found." }],
						details: undefined,
					};
				}

				let output = stdout;
				if (output.length > MAX_OUTPUT_LENGTH) {
					output = `${output.substring(0, MAX_OUTPUT_LENGTH)}\n... (truncated)`;
				}

				const mode = apply ? "APPLIED" : "DRY-RUN (preview)";
				return {
					content: [{ type: "text", text: `[${mode}]\n\n${output}` }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `ast-rewrite execution error: ${(error as Error).message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
