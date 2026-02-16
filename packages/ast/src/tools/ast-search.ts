import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "../utils/exec.js";

const MAX_OUTPUT_LENGTH = 10000;

interface SgMatch {
	file: string;
	range: {
		start: { line: number };
		end: { line: number };
	};
	text: string;
}

export function registerAstSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast_search",
		label: "AST Search",
		description: "Search code using AST patterns with ast-grep (sg)",
		parameters: Type.Object({
			pattern: Type.String({ description: "AST pattern to search for" }),
			path: Type.Optional(Type.String({ description: "File or directory to search in" })),
			lang: Type.Optional(Type.String({ description: "Language to use for parsing" })),
		}),
		execute: async (_toolCallId, { pattern, path, lang }) => {
			try {
				const args = ["sg", "run", "--pattern", pattern, "--json"];
				if (lang) {
					args.push("--lang", lang);
				}
				if (path) {
					args.push(path);
				}

				const { exitCode, stdout, stderr } = await exec(args);

				if (exitCode !== 0) {
					// sg returns non-zero if no matches? No, usually 0 even if no matches.
					// But if it fails to parse pattern, it returns non-zero.
					return {
						content: [{ type: "text", text: `ast-search failed: ${stderr}` }],
						isError: true,
						details: undefined,
					};
				}

				if (!stdout.trim()) {
					return {
						content: [{ type: "text", text: "No matches found." }],
						details: undefined,
					};
				}

				let results: SgMatch[];
				try {
					results = JSON.parse(stdout);
				} catch (e) {
					return {
						content: [
							{ type: "text", text: `Failed to parse ast-search output: ${(e as Error).message}\nOutput: ${stdout}` },
						],
						isError: true,
						details: undefined,
					};
				}

				if (!Array.isArray(results)) {
					return {
						content: [{ type: "text", text: `Unexpected output format from ast-search: ${stdout}` }],
						isError: true,
						details: undefined,
					};
				}

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No matches found." }],
						details: undefined,
					};
				}

				let output = "";
				for (const match of results) {
					const file = match.file;
					const startLine = match.range.start.line + 1;
					const endLine = match.range.end.line + 1;
					const text = match.text;

					output += `${file}:${startLine}-${endLine}:\n${text}\n\n`;
				}

				if (output.length > MAX_OUTPUT_LENGTH) {
					output = `${output.substring(0, MAX_OUTPUT_LENGTH)}\n... (truncated)`;
				}

				return {
					content: [{ type: "text", text: output.trim() }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `ast-search execution error: ${(error as Error).message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
