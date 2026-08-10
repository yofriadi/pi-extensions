import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function waitForMarker(path: string): Promise<void> {
	return new Promise((resolve) => {
		const timer = setInterval(() => {
			if (!existsSync(path)) return;
			clearInterval(timer);
			resolve();
		}, 100);
	});
}

export default function reloadTrigger(pi: ExtensionAPI): void {
	pi.registerCommand("test-reload", {
		description: "Integration-only: start a turn and reload after its child marker appears",
		handler: async (_args, ctx) => {
			const marker = process.env.PI_TEST_RELOAD_MARKER;
			const task = process.env.PI_TEST_RELOAD_TASK;
			if (!marker || !task) throw new Error("Missing PI_TEST_RELOAD_MARKER or PI_TEST_RELOAD_TASK");
			pi.sendUserMessage(task);
			await waitForMarker(marker);
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});

	pi.on("session_shutdown", (event) => {
		if ((event as any).reason !== "reload") return;
		const marker = process.env.PI_TEST_RELOAD_MARKER;
		if (marker) writeFileSync(`${marker}.reloaded`, "reload\n");
	});
}
