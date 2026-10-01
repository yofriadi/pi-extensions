# Capability: sound-playback

## Purpose

Cross-platform, best-effort playback of user-configured sound files.

## Requirements

### Requirement: Backend detection

The system SHALL detect a playback backend per platform by probing for known binaries on PATH (macOS: `afplay`; Linux: `paplay` then `aplay`; Windows: `powershell.exe`; fallback: terminal bell) and MUST memoize the result for the process lifetime.

#### Scenario: macOS with afplay

- **WHEN** the platform is `darwin` and `afplay` exists on PATH
- **THEN** the backend is `darwin` and playback invokes `afplay <file>`

#### Scenario: No desktop binary available

- **WHEN** no known playback binary exists on PATH and stderr is a TTY
- **THEN** the backend falls back to writing the terminal bell character to stderr

#### Scenario: Bell suppressed off-TTY

- **WHEN** the backend is the terminal bell fallback and stderr is not a TTY (print/rpc mode, piped output)
- **THEN** no output is written

### Requirement: Multiple files per trigger with random selection

The system SHALL accept an array of file paths per trigger and MUST select exactly one file at random on each fire.
A single-element array MUST always be selected.
A bare string in configuration MUST be normalized to a one-element array.

#### Scenario: Random pick among three files

- **WHEN** a trigger configured with three files fires repeatedly
- **THEN** each fire plays exactly one of the three files, chosen at random

### Requirement: Missing sound file is silent

The system SHALL check that the selected file exists before spawning a player and MUST skip playback silently when the file is missing or unreadable.

#### Scenario: Deleted sound file

- **WHEN** the selected file does not exist on disk
- **THEN** no player process is spawned and no error is surfaced to the user or agent loop

### Requirement: Fire-and-forget playback

Playback MUST be asynchronous and non-blocking: the system SHALL NOT use synchronous process spawning and SHALL NOT await the player process before returning from an event handler.

#### Scenario: Long sound file during agent run

- **WHEN** a 10-second sound file starts playing while the agent continues working
- **THEN** the event handler returns immediately and the agent loop is not blocked

### Requirement: Playback never breaks the agent loop

All playback paths MUST be best-effort: any failure (missing binary, spawn error, player exit error) SHALL be swallowed and MUST NOT propagate out of an event handler.

#### Scenario: Player binary crashes

- **WHEN** the player process exits with a non-zero status
- **THEN** the extension continues operating with no thrown error

### Requirement: Volume hint

The system SHALL accept a volume value in the range 0..1 and MUST clamp out-of-range values.
Volume MUST be applied where the backend supports it: macOS `afplay -v <v>` takes 0..1 natively, and Linux `paplay --volume` takes 0..65536 so the hint MUST be scaled (`Math.round(v * 65536)`); other backends (`aplay`, Windows beep, terminal bell) rely on system volume.

#### Scenario: Volume clamping and scaling

- **WHEN** configured volume is `2.5`
- **THEN** the effective volume passed to supporting backends is `1` (`afplay -v 1`, `paplay --volume=65536`)
