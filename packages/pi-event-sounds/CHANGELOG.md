# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release as `@yofriadi/pi-event-sounds`: configurable sound effects for pi-coding-agent lifecycle events and derived triggers — `sessionStart`, `promptSubmit`, `agentStart`, `agentSettled`, `question` (extension UI prompts), `error` (tool errors, once per turn), `quota` (assistant error text matching configurable patterns), `turns` (turn-count milestones), and `elapsed` (one-shot or repeating run timers).
- Multiple files per trigger with random selection per fire; bare strings normalized to one-element arrays.
- Cross-platform best-effort playback: `afplay` (macOS), `paplay`/`aplay` (Linux), PowerShell `Media.SoundPlayer` (Windows), terminal bell on stderr (TTY-gated fallback).
- `sounds` configuration block in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global); cached per session and refreshed on every `session_start`.
- `--no-sounds` CLI flag to silence the current run regardless of configuration.
