/**
 * `/tilth-savings` — user-invoked report of tilth's session savings.
 *
 * The server's own description restricts `tilth_savings` to explicit user
 * requests, which is exactly what a command is; it is deliberately not
 * registered as a model-callable tool. Tool-style failures throw; command
 * failures notify.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { unavailableMessage } from "../lib/availability";
import { applyTruncation } from "../lib/truncate";
import { runTilthCall, type TilthToolDeps } from "../toolkit";

export function registerSavingsCommand(pi: ExtensionAPI, deps: TilthToolDeps): void {
	pi.registerCommand("tilth-savings", {
		description: "Report tokens tilth saved this session vs naive grep/cat",
		handler: async (_args, ctx: ExtensionContext) => {
			if (deps.availability.mode === "unavailable") {
				ctx.ui.notify(unavailableMessage(), "warning");
				return;
			}
			try {
				const { text: output } = await runTilthCall({
					deps,
					toolName: "tilth_savings",
					params: {},
					cwd: ctx.cwd,
				});
				// Command output goes through the same budget/truncation pipeline
				// as tool output so a pathological report cannot blow the notify.
				const truncation = await applyTruncation(output);
				ctx.ui.notify(truncation.text, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`tilth_savings failed: ${message}`, "warning");
			}
		},
	});
}
