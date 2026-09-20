# @yofriadi/pi-thinking-preview

Collapse streaming thinking blocks into a compact, live-refreshing preview.

Fork of [`@pi-spice/thinking-preview`](https://github.com/0x2E/pi-spice/tree/main/extensions/thinking-preview) with two fixes:

1. **Italic-safe marker.**
   The default marker is `✶` (U+2736) instead of upstream's `✻` (U+273B). pi renders blockquotes — and this preview is a blockquote — through `theme.quote(theme.italic(text))`, so the marker is drawn by your terminal's *italic* font face.
   Terminal fallback chains are face-specific: with `JetBrainsMonoNL Nerd Font Mono` in Alacritty, the regular face cascades to Menlo-Regular (which has U+273B) but the italic face cascades to Menlo-Italic (which does not), so the marker draws as a `.notdef` box — a rectangle with a diagonal slash.
   U+2736 exists natively in the regular *and* italic faces of JetBrainsMono/Monaspice Nerd Fonts and in Menlo, so it renders in-font with matching weight and baseline.
2. **Configurable marker and toggle key.** `--thinking-marker` and `--thinking-toggle-key` flags (env: `PI_THINKING_PREVIEW_MARKER`, `PI_THINKING_PREVIEW_TOGGLE_KEY`), because multiplexers swallow `alt+t` — herdr binds `new_tab = "alt+t"`, so the upstream hint never reaches pi.

```text
│ ✶ thinking · 142 lines · alt+t to expand
│ …second-to-last line of the thinking…
│ …last line of the thinking…
```

The block renders as a blockquote, so it carries pi's `│` left bar and quote color — visually distinct from plain thinking text, echoing the framed look of tool-call rows.

The preview refreshes on every streaming token, so the block doubles as a progress indicator — no flooding, but you always roughly know where the model is.

## Install

```bash
pi install npm:@yofriadi/pi-thinking-preview
```

Quick test without installing: `pi -e ./packages/pi-thinking-preview/`

## Configuration

Precedence: CLI flag → environment variable → default.

| Flag                          | Env                              | Default | Purpose                                                                                                                              |
| ----------------------------- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--thinking-marker <glyph>`   | `PI_THINKING_PREVIEW_MARKER`     | `✶`     | Status-line marker. Must render in your terminal's *italic* face.                                                                    |
| `--thinking-toggle-key <key>` | `PI_THINKING_PREVIEW_TOGGLE_KEY` | `alt+t` | Toggle key, e.g. `alt+o` when a multiplexer consumes `alt+t`. Key identifiers follow pi-tui's `KeyId` format (`ctrl+c`, `alt+o`, …). |

```bash
# persistent, no flags per launch:
export PI_THINKING_PREVIEW_TOGGLE_KEY=alt+o
```

Marker candidates that draw in-font in JetBrainsMono/Monaspice Nerd Font Mono (both faces): `✶ ● ◆ • ◦ ▪ ▸ ✓`.
Glyphs that break in the italic cascade on stock macOS + Alacritty: `✻ ✺ ✸ ✷ ✲ ✯ ✭ ✫ ✩ ✦ ❋ ❉ ❃` (tofu) and `✳ ✴ ❄ ★` (fall back to 20×20 color emoji).
`✻` works only if the regular face happens to catch it — not under pi's italic blockquote styling.

## How it works

- Uses a Markdown transformer (`pi.registerMarkdownTransformer`), which is **display-only**: the session file and the model context keep the full thinking text, untouched.
- Preview content is plain text — Markdown syntax characters are escaped and rendered verbatim — and every preview line (status line included) is hard-clipped to the available terminal width minus the `│` bar, by plain character count with no per-charset width tables.
  A line of wide characters (CJK, emoji) can therefore render up to twice the budget and wrap an occasional extra row — accepted jitter in exchange for simplicity.
- The configured toggle key (or `/thinking-preview`) toggles **all** thinking blocks between preview and full text.
  Expanded mode shows the full text as escaped plain text inside the same `│ `-framed block, with source line breaks preserved; long lines wrap naturally.
  Toggling re-renders history immediately and shows a notification.
  Restart resets to the collapsed preview default.
- The toggle is global and sticky: once expanded, new thinking blocks render in full until you toggle back.

## Interaction with pi's built-in thinking controls

- `ctrl+t` (hide thinking blocks) takes precedence: while thinking is hidden, blocks render as a one-line label and this extension has no visible effect on the transcript — though the toggle notification still fires.
  Press `ctrl+t` to make thinking visible again.
- `ctrl+t` *showing* thinking also goes through this extension, so it shows the preview — not full text.
  Use the toggle key for full text.
- Toggling re-applies the default hidden-thinking label (`Thinking...`); if you customized that label elsewhere, it will be reset on toggle.

## Notes

- Old thinking blocks pick up a mode change immediately (the toggle forces a re-render), and restored sessions render collapsed previews too.
- Upstream chose `alt+t` because every `ctrl+letter` combination is bound in pi's default keybindings.
  If yours is bound elsewhere, `/thinking-preview` works as a fallback.

## Credits

Upstream thinking-preview is © 0x2E, MIT — [pi-spice/extensions/thinking-preview](https://github.com/0x2E/pi-spice/tree/main/extensions/thinking-preview).
This fork keeps the transformer behavior byte-for-byte apart from the marker default and the configuration knobs.
