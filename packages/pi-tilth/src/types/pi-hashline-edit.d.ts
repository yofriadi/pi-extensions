/**
 * Type declarations for the `pi-hashline-edit/compat` subpath.
 *
 * pi-hashline-edit ships strip-only TypeScript without generated .d.ts files,
 * so the consumer declares the versioned compat contract here (kept in sync
 * with its src/compat.ts — see hashline-compat spec). A runtime shape check
 * in resolveCompatModule() rejects a drifting module.
 */
declare module "pi-hashline-edit/compat" {
	export const COMPAT_VERSION: number;
	/** Internal: flipped by pi-hashline-edit's index.ts at extension load. */
	export function setHashlineEditActive(value: boolean): void;
	export function isHashlineEditActive(): boolean;
	export function readNormalizedForAnnotate(path: string): Promise<{ normalized: string; lines: string[] } | null>;
	export function commitExternalRead(path: string, normalized: string): Promise<void>;
	export function mintAnchor(fileLines: string[], line1: number): string;
}
