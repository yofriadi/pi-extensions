import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { LspRuntimeRegistry } from "../client/registry.js";
import type { ResolvedLspConfig } from "../config/resolver.js";

export interface LspToolRouter {
	register(pi: ExtensionAPI): void;
}

export interface LspToolRouterOptions {
	cwd?: string;
	getResolvedConfig: () => ResolvedLspConfig;
}

const LspActionSchema = Type.Union([
	Type.Literal("diagnostics"),
	Type.Literal("definition"),
	Type.Literal("references"),
	Type.Literal("hover"),
	Type.Literal("symbols"),
	Type.Literal("rename"),
	Type.Literal("status"),
	Type.Literal("reload"),
]);

const LspToolSchema = Type.Object({
	action: LspActionSchema,
	path: Type.Optional(Type.String({ description: "File path (relative or absolute) for document-scoped actions" })),
	line: Type.Optional(Type.Number({ description: "Zero-based line for position-based actions" })),
	character: Type.Optional(Type.Number({ description: "Zero-based character for position-based actions" })),
	newName: Type.Optional(Type.String({ description: "New symbol name for rename action" })),
	query: Type.Optional(Type.String({ description: "Workspace query for symbols action" })),
	includeDeclaration: Type.Optional(
		Type.Boolean({ description: "Whether references action should include declaration locations" }),
	),
});

type LspToolParams = Static<typeof LspToolSchema>;

interface LspToolDetails {
	action: LspToolParams["action"];
	payload?: unknown;
}

export function createLspToolRouter(runtime: LspRuntimeRegistry, options: LspToolRouterOptions): LspToolRouter {
	const cwd = options.cwd ?? process.cwd();

	return {
		register(pi: ExtensionAPI): void {
			pi.registerTool({
				name: "lsp",
				label: "LSP",
				description: "Run LSP actions (diagnostics, definition, references, hover, symbols, rename, status, reload)",
				parameters: LspToolSchema,
				execute: async (_toolCallId, params: LspToolParams) => {
					const details = await executeAction(runtime, params, cwd, options.getResolvedConfig);
					return {
						content: [{ type: "text", text: renderDetails(details) }],
						details,
					};
				},
			});

			pi.registerTool({
				name: "lsp_health",
				label: "LSP Health",
				description: "Backward-compatible health status shortcut for the LSP extension package",
				parameters: Type.Object({}),
				execute: async () => {
					const details = await executeAction(runtime, { action: "status" }, cwd, options.getResolvedConfig);
					return {
						content: [{ type: "text", text: renderDetails(details) }],
						details,
					};
				},
			});
		},
	};
}

async function executeAction(
	runtime: LspRuntimeRegistry,
	params: LspToolParams,
	cwd: string,
	getResolvedConfig: () => ResolvedLspConfig,
): Promise<LspToolDetails> {
	switch (params.action) {
		case "status": {
			const status = runtime.getStatus();
			return { action: "status", payload: status };
		}
		case "reload": {
			await runtime.reload(getResolvedConfig());
			return { action: "reload", payload: runtime.getStatus() };
		}
		case "diagnostics": {
			if (params.path) {
				const uri = toFileUri(params.path, cwd);
				const payload = await runtime.request(
					"textDocument/diagnostic",
					{
						textDocument: { uri },
					},
					{ path: params.path },
				);
				return { action: "diagnostics", payload };
			}
			return { action: "diagnostics", payload: runtime.getPublishedDiagnostics() };
		}
		case "hover": {
			const position = requirePosition(params, cwd, "hover");
			const payload = await runtime.request(
				"textDocument/hover",
				{
					textDocument: { uri: position.uri },
					position: { line: position.line, character: position.character },
				},
				{ path: position.path },
			);
			return { action: "hover", payload };
		}
		case "definition": {
			const position = requirePosition(params, cwd, "definition");
			const payload = await runtime.request(
				"textDocument/definition",
				{
					textDocument: { uri: position.uri },
					position: { line: position.line, character: position.character },
				},
				{ path: position.path },
			);
			return { action: "definition", payload };
		}
		case "references": {
			const position = requirePosition(params, cwd, "references");
			const payload = await runtime.request(
				"textDocument/references",
				{
					textDocument: { uri: position.uri },
					position: { line: position.line, character: position.character },
					context: {
						includeDeclaration: params.includeDeclaration ?? false,
					},
				},
				{ path: position.path },
			);
			return { action: "references", payload };
		}
		case "symbols": {
			if (params.query) {
				const payload = await runtime.request("workspace/symbol", {
					query: params.query,
				});
				return { action: "symbols", payload };
			}
			if (!params.path) {
				throw new Error("symbols action requires either query or path.");
			}
			const uri = toFileUri(params.path, cwd);
			const payload = await runtime.request(
				"textDocument/documentSymbol",
				{
					textDocument: { uri },
				},
				{ path: params.path },
			);
			return { action: "symbols", payload };
		}
		case "rename": {
			if (!params.newName) {
				throw new Error("rename action requires newName.");
			}
			const position = requirePosition(params, cwd, "rename");
			const payload = await runtime.request(
				"textDocument/rename",
				{
					textDocument: { uri: position.uri },
					position: { line: position.line, character: position.character },
					newName: params.newName,
				},
				{ path: position.path },
			);
			return { action: "rename", payload };
		}
	}
}

function requirePosition(
	params: LspToolParams,
	cwd: string,
	action: "hover" | "definition" | "references" | "rename",
): { path: string; uri: string; line: number; character: number } {
	if (!params.path) {
		throw new Error(`${action} action requires path.`);
	}
	if (typeof params.line !== "number" || typeof params.character !== "number") {
		throw new Error(`${action} action requires line and character.`);
	}
	return {
		path: params.path,
		uri: toFileUri(params.path, cwd),
		line: params.line,
		character: params.character,
	};
}

function toFileUri(filePath: string, cwd: string): string {
	return pathToFileURL(resolve(cwd, filePath)).href;
}

const MAX_RENDERED_DETAILS_CHARS = 40_000;

function renderDetails(details: LspToolDetails): string {
	const header = `LSP action: ${details.action}`;
	if (details.payload === undefined) {
		return header;
	}

	const renderedPayload = safeJsonStringify(details.payload, MAX_RENDERED_DETAILS_CHARS);
	if (!renderedPayload) {
		return header;
	}

	return `${header}\n${renderedPayload}`;
}

function safeJsonStringify(payload: unknown, maxChars: number): string {
	let rendered: string;
	try {
		rendered = JSON.stringify(payload, null, 2) ?? "";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		rendered = `"<unserializable payload: ${message}>"`;
	}

	if (rendered.length <= maxChars) {
		return rendered;
	}
	return `${rendered.slice(0, maxChars)}\n... (truncated at ${maxChars} chars)`;
}
