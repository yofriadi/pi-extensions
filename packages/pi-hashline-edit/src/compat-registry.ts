/**
 * Process-global publish point for the verify-then-commit compat contract
 * (see src/compat.ts for the contract itself).
 *
 * Pi's extension loader creates a fresh jiti instance per extension
 * (`moduleCache: false`), so a consumer that *imports*
 * `pi-hashline-edit/compat` gets its own module copy with its own snapshot
 * store and activity flag — commits would land in a store the edit tool
 * cannot see. The one channel shared across extension module graphs is
 * `globalThis`, so index.ts publishes the real compat module (created inside
 * this extension's own module graph, closing over the store the edit tool
 * reads) under COMPAT_REGISTRY_KEY at extension load.
 *
 * The key literal is duplicated in @yofriadi/pi-tilth's
 * src/lib/hashline-bridge.ts: pi-tilth must read the registry even on
 * machines where `pi-hashline-edit/compat` cannot be imported at all, and
 * compat stays version-gated (COMPAT_VERSION + runtime shape check) so drift
 * fails safe — compat off, passthrough output, no store writes.
 */

export const COMPAT_REGISTRY_KEY = "__piHashlineEditCompat";
