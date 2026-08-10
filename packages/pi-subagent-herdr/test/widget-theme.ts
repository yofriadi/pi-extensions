import type { Theme } from "@earendil-works/pi-coding-agent";

function tagged(tag: string, text: string): string {
	return `\x1b]8;;${tag}\x07${text}\x1b]8;;\x07`;
}

/** Theme stub whose zero-width OSC tags make color assertions observable. */
export function createTaggedWidgetTheme(): Theme {
	return {
		fg(color: string, text: string) {
			return tagged(`tier:${color}`, text);
		},
		bg(color: string, text: string) {
			return tagged(`background:${color}`, text);
		},
		bold(text: string) {
			return tagged("style:bold", text);
		},
	} as Theme;
}

export function createPlainWidgetTheme(): Theme {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as Theme;
}
