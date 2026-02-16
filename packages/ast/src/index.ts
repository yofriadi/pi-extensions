import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerAstRewrite } from "./tools/ast-rewrite.js";
import { registerAstSearch } from "./tools/ast-search.js";
import { exec } from "./utils/exec.js";

export default function astExtension(pi: ExtensionAPI): void {
	// Register tools
	registerAstSearch(pi);
	registerAstRewrite(pi);

	pi.registerTool({
		name: "sg_health",
		label: "AST-Grep Health",
		description: "Check if ast-grep (sg) is installed and available",
		parameters: Type.Object({}),
		execute: async () => {
			try {
				const { exitCode, stdout, stderr } = await exec(["sg", "--version"]);

				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: `ast-grep (sg) check failed: ${stderr}` }],
						isError: true,
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text: `ast-grep (sg) is available: ${stdout.trim()}` }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `ast-grep (sg) check failed: ${(error as Error).message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
