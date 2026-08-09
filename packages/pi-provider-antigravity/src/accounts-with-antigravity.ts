import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import accountsExtension, { createBuiltinProviderAdapters } from "@narumitw/pi-accounts";
import { ANTIGRAVITY_ACCOUNT_ADAPTER } from "./account-adapter.ts";

/**
 * Composable `/accounts` host that registers Pi's built-in provider adapters
 * plus the Antigravity account adapter.
 *
 * Pi's extension loader always calls `factory(api)` with a single argument, so
 * installing both packages never injects `ANTIGRAVITY_ACCOUNT_ADAPTER` into the
 * default `pi-accounts` entrypoint. This host is the installable composition
 * path for Antigravity named accounts.
 *
 * If both this host and `@narumitw/pi-accounts` load in one session,
 * `accountsExtension` merges adapters into a single shared runtime instead of
 * double-binding builtin providers. Prefer installing only this package when
 * you want Antigravity in `/accounts`.
 */
export default function accountsWithAntigravityExtension(pi: ExtensionAPI): void {
	accountsExtension(pi, {
		providers: [...createBuiltinProviderAdapters(), ANTIGRAVITY_ACCOUNT_ADAPTER],
	});
}
