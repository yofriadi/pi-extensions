# subagent-auto-retry-and-resume

Automatic in-extension subagent retries on transient/quota error (3 total attempts: initial run + up to 2 automatic retries, relaunching the same session through the standard launch path), an ownership-gated `session` tool parameter for explicit resume, removal of the `seed` frontmatter option (always fresh context), and a shortened wake notice

**Sequencing:** lands after `folder-based-subagent-artifacts` (its `pane-surface` and `completion-delivery` deltas are written against that change's merged base text).
