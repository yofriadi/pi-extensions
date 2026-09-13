/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 *
 * Module layout:
 *   hashline/hash.ts   — hash alphabet, xxh32, per-line hash, fuzzy normalization
 *   hashline/parse.ts  — types, prefix regexes, anchor parsing, resolveEditAnchors
 *   hashline/apply.ts  — edit engine: anchor validation, span resolution, assembly
 *   hashline/format.ts — formatHashlineRegion, computeAffectedLineRange, computeChangedLineRange
 */

export type { HashlineToolEdit } from "./hashline/parse";
/** @internal Test-only re-exports: production code imports the deep modules. */
export type { Anchor, HashlineEdit } from "./hashline/parse";
export { computeLineHash } from "./hashline/hash";
/** @internal Test-only re-export: production code imports the deep module. */
export { computeHashFromContext } from "./hashline/hash";
export { resolveEditAnchors } from "./hashline/parse";
export { applyHashlineEdits } from "./hashline/apply";
export {
	computeAffectedLineRange,
	formatHashlineRegion,
	computeChangedLineRange,
} from "./hashline/format";
