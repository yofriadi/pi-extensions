/**
 * Text normalization utilities for fuzzy matching.
 */

/** Count leading whitespace characters in a line */
export function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/**
 * Normalize common Unicode punctuation to ASCII equivalents.
 */
export function normalizeUnicode(s: string): string {
	return s
		.trim()
		.split("")
		.map((c) => {
			const code = c.charCodeAt(0);

			if (
				code === 0x2010 ||
				code === 0x2011 ||
				code === 0x2012 ||
				code === 0x2013 ||
				code === 0x2014 ||
				code === 0x2015 ||
				code === 0x2212
			) {
				return "-";
			}

			if (code === 0x2018 || code === 0x2019 || code === 0x201a || code === 0x201b) {
				return "'";
			}

			if (code === 0x201c || code === 0x201d || code === 0x201e || code === 0x201f) {
				return '"';
			}

			if (
				code === 0x00a0 ||
				code === 0x2002 ||
				code === 0x2003 ||
				code === 0x2004 ||
				code === 0x2005 ||
				code === 0x2006 ||
				code === 0x2007 ||
				code === 0x2008 ||
				code === 0x2009 ||
				code === 0x200a ||
				code === 0x202f ||
				code === 0x205f ||
				code === 0x3000
			) {
				return " ";
			}

			return c;
		})
		.join("");
}

/**
 * Normalize a line for fuzzy comparison.
 */
export function normalizeForFuzzy(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "";

	return trimmed
		.replace(/[""„‟«»]/g, '"')
		.replace(/[''‚‛`´]/g, "'")
		.replace(/[‐‑‒–—−]/g, "-")
		.replace(/[ \t]+/g, " ");
}
