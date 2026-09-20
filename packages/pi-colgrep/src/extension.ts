import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAvailabilityState } from "./lib/availability";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
} from "./lib/config";
import { checkIndexExists } from "./lib/index-status";
import { createReindexer, type Reindexer } from "./lib/reindex";
import { registerColGrep } from "./tools/colgrep";

const COLGREP_STATUS_KEY = "colgrep";

function setColGrepStatus(
  ctx: { ui: { setStatus?: (key: string, text: string | undefined) => void } },
  text: string | undefined,
): void {
  if (typeof ctx.ui.setStatus === "function") {
    ctx.ui.setStatus(COLGREP_STATUS_KEY, text);
  }
}

export default function piColGrepExtension(pi: ExtensionAPI): void {
  const availability = createAvailabilityState();
  let reindexer: Reindexer | undefined;
  // Whether a colgrep index exists for the current session's cwd. Probed once
  // on session_start and flipped true when an index is built. The write/edit
  // auto-reindex is gated on this so we never proactively index a directory
  // the operator never searches.
  let indexExists = false;
  // Limits the "no index, skipping" notice to one per session.
  let skipWarned = false;

  registerColGrep(pi, {
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    availability,
  });

  pi.on("session_start", async (_event, ctx) => {
    const exec = (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
    ) => pi.exec(cmd, args, opts);

    await availability.refresh(exec);

    if (!availability.available) {
      ctx.ui.notify(
        "colgrep is not installed. Semantic code search will not be available.\n" +
          "Install from: https://github.com/lightonai/next-plaid#installation",
        "warning",
      );
      return;
    }

    const config = loadConfig({
      globalConfigPath: getGlobalConfigPath(getAgentDir()),
      projectConfigPath: getProjectConfigPath(ctx.cwd),
    });

    reindexer = createReindexer({
      exec,
      cwd: ctx.cwd,
      onStatus: (text) => setColGrepStatus(ctx, text),
    });

    skipWarned = false;
    indexExists = await checkIndexExists(exec, ctx.cwd);

    if (config.indexOnStartup) {
      // Fire-and-forget: kick the index build off in the background so it never
      // blocks Pi startup. `shutdown()` awaits the in-flight run on session end.
      void reindexer.runNow();
      indexExists = true;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (!indexExists) {
      if (!skipWarned) {
        skipWarned = true;
        ctx.ui.notify(
          "colgrep: skipping auto-reindex — no index for this directory. " +
            "Run /colgrep-reindex to build one.",
          "info",
        );
      }
      return;
    }
    reindexer?.schedule();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await reindexer?.shutdown();
    reindexer = undefined;
  });

  pi.registerCommand("colgrep-reindex", {
    description: "Manually refresh the ColGrep semantic search index",
    handler: async (_args, ctx) => {
      if (!availability.available) {
        ctx.ui.notify(
          "colgrep is not installed. Install from: https://github.com/lightonai/next-plaid#installation",
          "warning",
        );
        return;
      }

      const exec = (
        cmd: string,
        args: string[],
        opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
      ) => pi.exec(cmd, args, opts);

      // Use the session reindexer if available; otherwise create a one-shot
      // one (e.g., if the command is invoked before session_start has run).
      const indexer =
        reindexer ??
        createReindexer({
          exec,
          cwd: ctx.cwd,
          onStatus: (text) => setColGrepStatus(ctx, text),
        });

      await indexer.runNow();
      // A manual reindex establishes an index, so resume write/edit reindexing.
      indexExists = true;
      ctx.ui.notify("ColGrep index updated.", "info");
    },
  });
}
