/**
 * Minimal stub for `@oh-my-pi/pi-utils` to keep the vendored schema normalizer
 * free of external runtime dependencies. Only `logger.debug` is called in the
 * vendored code paths, and `$flag` is used by `adapt.ts` (which we do not use
 * directly). Replace with real `@oh-my-pi/pi-utils` if/when this extension
 * loads in an environment that provides it.
 */

const noop = (..._args: unknown[]): void => {};

export const logger = {
	debug: noop,
	info: noop,
	warn: noop,
	error: noop,
};

export const $flag = Symbol.for("pi.utils.flag");
