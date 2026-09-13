import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as compat from "./src/compat";
import { COMPAT_REGISTRY_KEY } from "./src/compat-registry";
import { registerEditTool } from "./src/edit";
import { registerGrepTool } from "./src/grep";
import { registerReadTool } from "./src/read";
import { getGrepEnabled, getConfigWarnings } from "./src/config";

export default function (pi: ExtensionAPI): void {
	// Flip the compat activity flag at load so external consumers (e.g.
	// pi-tilth) can verify-then-commit reads against the shared store.
	compat.setHashlineEditActive(true);
	// Publish the compat contract on the process global. Pi loads every
	// extension in an isolated jiti instance (moduleCache: false), so an
	// extension that imports `pi-hashline-edit/compat` gets a separate
	// module copy — its own snapshot store, its own activity flag — and its
	// commits would land in a store the edit tool cannot see. The object
	// below is built in THIS module graph, so its functions close over the
	// same store the edit tool reads; globalThis is the one channel shared
	// across extension module graphs.
	(globalThis as Record<string, unknown>)[COMPAT_REGISTRY_KEY] = {
		COMPAT_VERSION: compat.COMPAT_VERSION,
		isHashlineEditActive: compat.isHashlineEditActive,
		readNormalizedForAnnotate: compat.readNormalizedForAnnotate,
		commitExternalRead: compat.commitExternalRead,
		mintAnchor: compat.mintAnchor,
	};
	registerReadTool(pi);
	registerEditTool(pi);
	if (getGrepEnabled()) {
		registerGrepTool(pi);
	}

	pi.on("session_start", async (_event, ctx) => {
		const warnings = getConfigWarnings();
		if (warnings.length > 0) {
			ctx.ui.notify(
				`hashline.json config warnings:\n${warnings.join("\n")}`,
				"warning",
			);
		}

		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify("Hashline Edit mode active", "info");
		}
	});
}
