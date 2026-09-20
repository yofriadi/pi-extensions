# Changelog

## 0.1.0 (fork of @pi-spice/thinking-preview 0.1.2)

### Changed

- Default marker is `✶` (U+2736) instead of `✻` (U+273B). pi renders blockquotes with the terminal's italic style, and font fallback chains differ per face: with JetBrainsMonoNL Nerd Font Mono in Alacritty, U+273B resolves through the regular face's cascade (Menlo-Regular) but has no glyph in the italic face's cascade (Menlo-Italic), producing a `.notdef` tofu box. U+2736 is native in both faces of JetBrainsMono/Monaspace Nerd Font Mono and in Menlo.

### Added

- `--thinking-marker` flag (env `PI_THINKING_PREVIEW_MARKER`) to choose the status-line glyph without editing source.
- `--thinking-toggle-key` flag (env `PI_THINKING_PREVIEW_TOGGLE_KEY`) to rebind the toggle when a multiplexer consumes `alt+t` (herdr binds `new_tab = "alt+t"`).
- Loader-level integration test through `discoverAndLoadExtensions`, plus unit tests for marker/key resolution, clipping, and markdown escaping.
