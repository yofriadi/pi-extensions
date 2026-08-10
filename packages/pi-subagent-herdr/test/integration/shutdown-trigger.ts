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

export default function shutdownTrigger(pi: ExtensionAPI): void {
	pi.registerCommand("test-shutdown", {
		description: "Integration-only: start a turn and report when the parent is idle",
		handler: async (_args, ctx) => {
			const marker = process.env.PI_TEST_SHUTDOWN_MARKER;
			const task = process.env.PI_TEST_SHUTDOWN_TASK;
			if (!marker || !task) throw new Error("Missing PI_TEST_SHUTDOWN_MARKER or PI_TEST_SHUTDOWN_TASK");
			pi.sendUserMessage(task);
			await waitForMarker(marker);
			await ctx.waitForIdle();
			writeFileSync(`${marker}.idle`, "idle\n");
		},
	});
}
