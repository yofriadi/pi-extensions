import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { LspClientRuntime } from "../client/runtime.js";

export interface LspToolRouter {
	register(pi: ExtensionAPI): void;
}

export interface LspToolRouterOptions {
	cwd?: string;
	getServerCommand: () => string[] | undefined;
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

export function createLspToolRouter(runtime: LspClientRuntime, options: LspToolRouterOptions): LspToolRouter {
	const cwd = options.cwd ?? process.cwd();

	return {
		register(pi: ExtensionAPI): void {
			pi.registerTool({
				name: "lsp",
				label: "LSP",
				description: "Run LSP actions (diagnostics, definition, references, hover, symbols, rename, status, reload)",
				parameters: LspToolSchema,
				execute: async (_toolCallId, params: LspToolParams) => {
					const details = await executeAction(runtime, params, cwd, options.getServerCommand);
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
					const details = await executeAction(runtime, { action: "status" }, cwd, options.getServerCommand);
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
	runtime: LspClientRuntime,
	params: LspToolParams,
	cwd: string,
	getServerCommand: () => string[] | undefined,
): Promise<LspToolDetails> {
	switch (params.action) {
		case "status": {
			const status = runtime.getStatus();
			return { action: "status", payload: status };
		}
		case "reload": {
			await runtime.reload(getServerCommand());
			return { action: "reload", payload: runtime.getStatus() };
		}
		case "diagnostics": {
			if (params.path) {
				const uri = toFileUri(params.path, cwd);
				const payload = await runtime.request("textDocument/diagnostic", {
					textDocument: { uri },
				});
				return { action: "diagnostics", payload };
			}
			return { action: "diagnostics", payload: runtime.getPublishedDiagnostics() };
		}
		case "hover": {
			const { uri, line, character } = requirePosition(params, cwd, "hover");
			const payload = await runtime.request("textDocument/hover", {
				textDocument: { uri },
				position: { line, character },
			});
			return { action: "hover", payload };
		}
		case "definition": {
			const { uri, line, character } = requirePosition(params, cwd, "definition");
			const payload = await runtime.request("textDocument/definition", {
				textDocument: { uri },
				position: { line, character },
			});
			return { action: "definition", payload };
		}
		case "references": {
			const { uri, line, character } = requirePosition(params, cwd, "references");
			const payload = await runtime.request("textDocument/references", {
				textDocument: { uri },
				position: { line, character },
				context: {
					includeDeclaration: params.includeDeclaration ?? false,
				},
			});
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
			const payload = await runtime.request("textDocument/documentSymbol", {
				textDocument: { uri },
			});
			return { action: "symbols", payload };
		}
		case "rename": {
			if (!params.newName) {
				throw new Error("rename action requires newName.");
			}
			const { uri, line, character } = requirePosition(params, cwd, "rename");
			const payload = await runtime.request("textDocument/rename", {
				textDocument: { uri },
				position: { line, character },
				newName: params.newName,
			});
			return { action: "rename", payload };
		}
	}
}

function requirePosition(
	params: LspToolParams,
	cwd: string,
	action: "hover" | "definition" | "references" | "rename",
): { uri: string; line: number; character: number } {
	if (!params.path) {
		throw new Error(`${action} action requires path.`);
	}
	if (typeof params.line !== "number" || typeof params.character !== "number") {
		throw new Error(`${action} action requires line and character.`);
	}
	return {
		uri: toFileUri(params.path, cwd),
		line: params.line,
		character: params.character,
	};
}

function toFileUri(filePath: string, cwd: string): string {
	return pathToFileURL(resolve(cwd, filePath)).href;
}

function renderDetails(details: LspToolDetails): string {
	const header = `LSP action: ${details.action}`;
	if (details.payload === undefined) {
		return header;
	}

	const renderedPayload = JSON.stringify(details.payload, null, 2);
	if (!renderedPayload) {
		return header;
	}

	return `${header}\n${renderedPayload}`;
}
