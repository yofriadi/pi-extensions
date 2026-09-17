# fix-custom-prompt-tool-surface

Stop `renderToolSurface` from appending a duplicate tool surface when a custom system prompt is in use: skip tool-surface rendering entirely when Pi reports a `customPrompt`, leaving the operator's prompt byte-identical.
Tool filtering, skill filtering, and enforcement are unchanged, and the assembled-prompt path keeps its existing relocation behavior.
Fixes gotgenes/pi-packages#919.
