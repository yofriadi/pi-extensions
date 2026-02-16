import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { registerAstRewrite } from "../src/tools/ast-rewrite.js";
import { registerAstSearch } from "../src/tools/ast-search.js";

// Using Bun-compatible dirname
const fixturesDir = join(import.meta.dirname, "fixtures");

// Mock ExtensionAPI
const createMockPi = () => {
	const tools: Record<string, ToolDefinition> = {};
	return {
		registerTool: (tool: ToolDefinition) => {
			tools[tool.name] = tool;
		},
		tools,
	};
};

describe("AST Extension Integration", () => {
	let mockPi: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		mockPi = createMockPi();
	});

	describe("ast_search", () => {
		it("should find patterns in TypeScript", async () => {
			// Register tool
			registerAstSearch(mockPi as unknown as ExtensionAPI);
			const tool = mockPi.tools.ast_search;
			expect(tool).toBeDefined();

			// Execute tool
			const params = {
				pattern: "console.log($A)",
				path: join(fixturesDir, "example.ts"),
				lang: "typescript",
			};

			// Mock context and other args
			// biome-ignore lint/suspicious/noExplicitAny: Mocking tool result
			const result = (await tool.execute("test-id", params, undefined, undefined, {} as unknown as any)) as any;

			expect(result.isError, result.content[0]?.type === "text" ? result.content[0].text : undefined).toBeFalsy();

			const content = result.content[0]?.type === "text" ? result.content[0].text : "";
			// Should verify output format
			expect(content).toContain("example.ts");
			// AST grep output usually includes line numbers
			// e.g. "example.ts:2-2:\n  console.log(\"Hello, \" + name);"

			// Just verify matched text is present
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Testing for literal string in output
			expect(content).toContain("console.log(`Hello, ${name}`)");
		});

		it("should find patterns in Rust", async () => {
			registerAstSearch(mockPi as unknown as ExtensionAPI);
			const tool = mockPi.tools.ast_search;

			const params = {
				pattern: "println!($A, $B)",
				path: join(fixturesDir, "example.rs"),
				lang: "rust",
			};

			// biome-ignore lint/suspicious/noExplicitAny: Mocking tool result
			const result = (await tool.execute("test-id", params, undefined, undefined, {} as unknown as any)) as any;

			expect(result.isError, result.content[0]?.type === "text" ? result.content[0].text : undefined).toBeFalsy();
			const content = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(content).toContain('println!("Hello, {}", name)');
		});
	});

	describe("ast_rewrite", () => {
		it("should dry-run rewrite in TypeScript", async () => {
			registerAstRewrite(mockPi as unknown as ExtensionAPI);
			const tool = mockPi.tools.ast_rewrite;
			expect(tool).toBeDefined();

			const params = {
				pattern: "console.log($A)",
				rewrite: "logger.info($A)",
				path: join(fixturesDir, "example.ts"),
				lang: "typescript",
				apply: false,
			};

			// biome-ignore lint/suspicious/noExplicitAny: Mocking tool result
			const result = (await tool.execute("test-id", params, undefined, undefined, {} as unknown as any)) as any;

			expect(result.isError, result.content[0]?.type === "text" ? result.content[0].text : undefined).toBeFalsy();
			const content = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toContain("[DRY-RUN (preview)]");
			// Verify diff output
			// sg output usually has @@ ... @@
			// and -old +new lines
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Testing for literal string in output
			expect(content).toContain("console.log(`Hello, ${name}`);");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Testing for literal string in output
			expect(content).toContain("logger.info(`Hello, ${name}`);");
		});
	});
});
