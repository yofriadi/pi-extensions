/**
 * Shared tool construction for the six tilth tools.
 *
 * Every tool: registers typebox params mirroring the server schema, consults
 * availability per call (throwing the static explanatory error when
 * unavailable), issues exactly one `mcporter call` through the Exec seam,
 * annotates tilth_read output with hashline anchors when compat is active,
 * truncates oversized output, and renders compact call/result lines via
 * pi-tui Text.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import { annotateReadOutput } from "./lib/annotate";
import { type AvailabilityState, getAdHocDescriptor, unavailableMessage } from "./lib/availability";
import type { TilthConfig } from "./lib/config";
import type { Exec } from "./lib/exec";
import type { CompatModule } from "./lib/hashline-bridge";
import { isCompatActive } from "./lib/hashline-bridge";
import { buildCallArgs, callMcporter } from "./lib/mcporter";
import { parseEnvelope, ServerToolError, TransportError } from "./lib/result";
import { applyScoping, readTargetPaths, type ScopeOptions, type ToolParams } from "./lib/scope";
import { applyTruncation } from "./lib/truncate";

export interface TilthToolDeps {
	exec: Exec;
	availability: AvailabilityState;
	config: TilthConfig;
	/** Settled compat module or null (null when off / not installed). */
	compat: CompatModule | null;
}

export interface ToolDetails {
	truncated: boolean;
	fullOutputPath?: string;
}

/** Common parameter descriptions copied from the live server schema. */
const ROOT_DESC = "Absolute project root; anchors relative paths and scopes. Required with any relative path/scope.";

export function rootParam() {
	return Type.Optional(Type.String({ description: ROOT_DESC }));
}

export function budgetParam(desc = "Max tokens in response.") {
	return Type.Optional(Type.Number({ description: desc }));
}

export interface TilthCallResult {
	/** Joined text of the server's content blocks. */
	text: string;
	/** The scoped params actually sent to the server (root injected, paths absolutized). */
	scopedParams: ToolParams;
}

/**
 * Run one tilth tool call end-to-end and return the tool result text
 * plus the scoped params that were forwarded to the server.
 * Shared by the six tools and the /tilth-savings command handler.
 */
export async function runTilthCall(options: {
	deps: Pick<TilthToolDeps, "exec" | "availability" | "config">;
	toolName: string;
	params: ToolParams;
	cwd: string;
	signal?: AbortSignal;
	/** Scope preparation for this tool (search-root tools inject a default scope). */
	scopeOptions?: ScopeOptions;
}): Promise<TilthCallResult> {
	const { deps, toolName, params, cwd, signal, scopeOptions } = options;
	if (deps.availability.mode === "unavailable") {
		throw new Error(unavailableMessage());
	}
	const mode = deps.availability.mode;
	if (mode !== "config" && mode !== "binary" && mode !== "npx") {
		throw new Error("tilth availability has not been probed yet. Try again shortly.");
	}

	const scoped = applyScoping(params, cwd, scopeOptions);
	const args = buildCallArgs({
		mode,
		serverName: deps.config.serverName,
		toolName,
		paramsJson: JSON.stringify(scoped),
		adHoc: mode === "config" ? undefined : getAdHocDescriptor(mode),
	});

	const result = await callMcporter(deps.exec, args, {
		cwd,
		timeoutMs: deps.config.callTimeoutMs,
		signal,
	});

	// Server-reported errors and transport failures both throw with the
	// server's/stderr's own message — pi marks a result as an error only when
	// execute() throws.
	const envelope = parseEnvelope(result);
	return { text: envelope.text, scopedParams: scoped };
}

export interface RegisterTilthToolOptions<S extends TSchema> {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: S;
	/** Render the call line (verb + target). */
	renderCallText: (args: Static<S>, theme: Theme) => string;
	/** Render the collapsed result summary. */
	renderResultSummary: (text: string, details: ToolDetails | undefined, theme: Theme) => string;
	/** Annotate the output with hashline anchors when compat is active. */
	annotate?: boolean;
	/**
	 * Inject a default `scope` (the resolved root) when the caller supplied
	 * none. Set only on tools whose `scope` is a search root: the server
	 * resolves an omitted scope to its own process cwd (a keep-alive mcporter
	 * daemon spawns it in the daemon directory, not the pi session) and
	 * ignores `root` for that purpose.
	 */
	defaultScope?: boolean;
}

export function registerTilthTool<S extends TSchema>(
	pi: ExtensionAPI,
	deps: TilthToolDeps,
	options: RegisterTilthToolOptions<S>,
): void {
	pi.registerTool({
		name: options.name,
		label: options.label,
		description: options.description,
		promptSnippet: options.promptSnippet,
		promptGuidelines: options.promptGuidelines,
		parameters: options.parameters,
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(options.renderCallText(args as Static<S>, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const r = result as {
				content?: Array<{ type: string; text?: string }>;
				details?: ToolDetails;
			};
			const output = r.content?.[0]?.type === "text" ? (r.content[0].text ?? "") : "";
			if (renderOptions.expanded) {
				const lines = output.split("\n").map((l) => theme.fg("toolOutput", `  ${l}`));
				text.setText(lines.join("\n"));
			} else {
				text.setText(options.renderResultSummary(output, r.details, theme));
			}
			return text;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const prepared = params as ToolParams;
			// tilth_read's `raw` is client-side: strip it before the server call
			// and skip annotation when set.
			const { raw, ...serverParams } = prepared;
			const { text: output, scopedParams } = await runTilthCall({
				deps,
				toolName: options.name,
				params: serverParams,
				cwd: ctx.cwd,
				signal,
				scopeOptions: options.defaultScope ? { defaultScope: true } : undefined,
			});

			let annotated = output;
			const compatModule = deps.compat;
			if (
				options.annotate &&
				!raw &&
				compatModule !== null &&
				isCompatActive(compatModule, deps.config.hashlineCompat)
			) {
				const targets = readTargetPaths(scopedParams);
				annotated = await annotateReadOutput({
					output,
					targetPaths: targets,
					compat: compatModule,
				});
			}

			const truncation = await applyTruncation(annotated);
			return {
				content: [{ type: "text", text: truncation.text }],
				details: {
					truncated: truncation.truncated,
					...(truncation.fullOutputPath ? { fullOutputPath: truncation.fullOutputPath } : {}),
				} satisfies ToolDetails,
			};
		},
	});
}

export { ServerToolError, TransportError };
