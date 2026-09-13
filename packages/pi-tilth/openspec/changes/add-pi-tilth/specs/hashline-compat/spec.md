## ADDED Requirements

### Requirement: pi-hashline-edit exposes a versioned, verify-then-commit compat contract for external content sources

pi-hashline-edit SHALL provide a public module surface (subpath export `./compat`) that lets another extension: read a file with canonicalization and normalization semantics identical to its own read tool **without** touching the snapshot store; mint anchors with full-file context; and commit an externally-produced read into the store (snapshot registration plus duplicate-payload guard clearing) as a separate explicit step that registers exactly the bytes the caller verified.
The surface SHALL also expose an activity flag set by the extension entry point so callers can distinguish "package resolvable" from "extension active", and a numeric compat-version constant.
The surface SHALL be purely additive: pi-hashline-edit used alone SHALL behave exactly as before.

#### Scenario: Compat module exists and is stable

- **WHEN** another extension imports the compat subpath
- **THEN** it receives a module carrying the numeric compat version, the activity-flag reader, a non-registering normalized-read operation, a commit operation, and the anchor minting helper

#### Scenario: Read and commit are separate

- **WHEN** a consumer invokes the normalized-read operation
- **THEN** no snapshot-store write occurs until the consumer explicitly invokes the commit operation

#### Scenario: Standalone behavior unchanged

- **WHEN** pi-hashline-edit is loaded without any consumer of the compat module
- **THEN** its read/edit/grep behavior, configuration, and outputs are identical to before this change

pi-tilth SHALL declare pi-hashline-edit as an optional peer dependency (never auto-installed) and SHALL resolve the compat module through the process-global registry that pi-hashline-edit's entry point publishes at extension load (`globalThis.__piHashlineEditCompat`), falling back to a guarded dynamic import of the exact specifier `pi-hashline-edit/compat` for same-module-tree runtimes where the registry is absent. pi's extension loader isolates every extension in its own jiti instance with `moduleCache: false`, so two extensions can never share a module instance directly; the registry exists precisely because the dynamic import alone yields a second module copy whose snapshot store and activity flag are invisible to the loaded extension's `edit` tool.
Any failure to resolve the module (registry miss and import failure), a compat-version mismatch, an inactive pi-hashline-edit extension, or config `hashlineCompat: false` SHALL be treated as "compat off" — silently, without errors, and without altering tool output.
When compat is off, pi-tilth SHALL return tilth's output verbatim.
Additionally, compat SHALL be off for a whole session when the `--tilth-no-hashline` flag is passed (overriding both config files), and for a single call when `tilth_read` is invoked with `raw: true` — a client-side parameter that is stripped before the call reaches the server and skips both annotation and the snapshot commit.

#### Scenario: pi-hashline-edit not installed

- **WHEN** the compat module cannot be resolved
- **THEN** pi-tilth operates normally, output passes through unmodified, and no error or warning about the missing package is shown

#### Scenario: Package installed but extension not active or registry absent

- **WHEN** the registry is absent and the dynamic-import fallback resolves a module copy whose activity flag is false (extension not loaded, or the loader-isolated instance never flipped the flag)
- **THEN** pi-tilth behaves as if compat were unavailable

#### Scenario: Per-session opt-out flag

- **WHEN** pi is launched with `--tilth-no-hashline`
- **THEN** no compat resolution is attempted for the session (no registry lookup, no import) and all `tilth_read` output passes through verbatim

#### Scenario: Per-call opt-out param

- **WHEN** `tilth_read` is invoked with `raw: true`
- **THEN** that call's output passes through verbatim, nothing is committed, and the `raw` key never reaches the server (it is client-side only)

#### Scenario: User disables compat

- **WHEN** `hashlineCompat: false` is set in pi-tilth config
- **THEN** no compat resolution is attempted and output passes through verbatim

### Requirement: Anchors minted for tilth output are indistinguishable from a native hashline read

When compat is active and a `tilth_read` call displays real file content (full-file or section regions) for a path, pi-tilth SHALL: read the file through the compat normalized-read operation; verify **every** recognized shown content line against the normalized lines; re-render each verified line using pi-hashline-edit's own anchor computation with full-file context; and only then commit the external read, so committed snapshots are indistinguishable from a native hashline-edit read and copied anchors validate in its `edit` tool.
Verification and commitment SHALL span all files named in the call (`path`/`paths`), independently per file.

#### Scenario: Edit accepts an anchor copied from tilth_read output

- **WHEN** compat is active, `tilth_read` displays lines of a file, and the model subsequently issues a hashline `edit` using an anchor copied from that tilth output
- **THEN** the edit validates the anchor against the committed snapshot exactly as if pi-hashline-edit's own read had produced it

#### Scenario: Multi-file read

- **WHEN** a `tilth_read` call covers several paths
- **THEN** every fully verified file is annotated and committed; a file that fails verification passes through unannotated and uncommitted without affecting the others

### Requirement: Annotation never fabricates anchors or snapshots

pi-tilth SHALL verify the displayed content equals the normalized disk content at that line number before annotating it, and SHALL commit a snapshot only after every recognized content line of that file verified.
On any mismatch (file changed since the server read it), any unrecognized line format (outlines, headers, separators), or any ambiguity about which file a region belongs to, pi-tilth SHALL pass that file's output through completely unannotated and SHALL NOT commit a snapshot for it.
Outline/scaffolding lines SHALL never receive anchors, and outline-only output SHALL result in no store writes at all.

#### Scenario: File changed between server read and annotation

- **WHEN** disk content at a shown line differs from the displayed content
- **THEN** that file's tilth output is returned verbatim, no anchors are minted for it, and no snapshot is committed for it

#### Scenario: Outline output

- **WHEN** `tilth_read` returns an outline (no content regions) for a large file
- **THEN** the output is untransformed and the snapshot store is untouched

### Requirement: Compat scope is limited to tilth_read in v1

Only `tilth_read` output SHALL be annotated. `tilth_search`, `tilth_grok`, and `tilth_deps` expansion regions SHALL pass through unannotated in this version, matching tilth's documented section-before-edit flow; extending annotation to expansions is an explicitly named follow-up, not incidental scope.

#### Scenario: Search expansion passes through

- **WHEN** compat is active and `tilth_search` returns expanded source blocks
- **THEN** the expansion text is returned exactly as the server produced it
