# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `turns` and `elapsed` accept a list of trigger blocks, each with its own files: `"turns": [{ "at": 25, "files": ["quarter.wav"] }, { "at": 100, "files": ["century.wav"] }]` gives every turn milestone its own sound, and `"elapsed": [{ "seconds": 300, "repeat": true, "files": ["tick.wav"] }, { "seconds": 1000, "files": ["gong.wav"] }]` does the same for time marks. Within one block, `turns.at` and `elapsed.seconds` take a number or a list sharing that block's files, `turns.every` stays the periodic form, and a block may combine `every` and `at`. Invalid entries or blocks are dropped; nothing breaks loading.
- New `agentFailed` and `agentAborted` event triggers, classified from the run's last assistant message (`agent_end`) `stopReason`: a run whose last attempt ended in `error` now plays `events.agentFailed` (falling back to the `error` list when unset), an `aborted` run plays `events.agentAborted` (no fallback — silent when unset), and only genuinely successful runs play `agentSettled`.
- `agentFailed`/`agentAborted` are each armed per `agent_start` attempt, so automatic retries re-classify and the last attempt's outcome wins.
- Runtime mute command: `/sounds` (alias `/event-sounds`) with `toggle`/`on`/`off`/`status`. The mute is in-memory, survives `/new` and `/resume`, never touches `settings.json`, and can only silence — it never forces playback on when `sounds.enabled` is false or `--no-sounds` was given.
- Initial release as `@yofriadi/pi-event-sounds`: configurable sound effects for pi-coding-agent lifecycle events and derived triggers — `sessionStart`, `promptSubmit`, `agentStart`, `agentSettled`, `question` (extension UI prompts), `error` (tool errors, once per turn), `quota` (assistant error text matching configurable patterns), `turns` (turn-count milestones), and `elapsed` (one-shot or repeating run timers).
- Multiple files per trigger with random selection per fire; bare strings normalized to one-element arrays.
- Cross-platform best-effort playback: `afplay` (macOS), `paplay`/`aplay` (Linux), PowerShell `Media.SoundPlayer` (Windows), terminal bell on stderr (TTY-gated fallback).
- `sounds` configuration block in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global); cached per session and refreshed on every `session_start`.
- `--no-sounds` CLI flag to silence the current run regardless of configuration.

### Changed

- **BREAKING**: `events.agentSettled` is now **success-only**. Previously every settled run — including ones that exhausted retries and ended in a provider error — played the settle sound, so a failed run could celebrate. Now a failed run plays `agentFailed` instead. Side effect for users who configured only `error`: failed runs now play that list at settle time in addition to the per-turn tool-error sound. Configure `agentFailed` (or leave `agentSettled` as-is for successes) to keep the old separation.
