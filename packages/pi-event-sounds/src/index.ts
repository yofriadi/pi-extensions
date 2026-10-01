/**
 * pi-event-sounds — configurable sound effects for pi-coding-agent.
 *
 * Plays user-configured sound files on Pi lifecycle events and derived
 * triggers: session start, prompt submit, agent start, run outcome
 * (settled, failed, or aborted), extension questions, tool errors
 * (per-turn dedupe), provider quota/rate-limit responses, turn
 * milestones, and elapsed-time reminders. Multiple files per trigger →
 * random pick per fire.
 *
 * Configuration lives under a `sounds` key in `.pi/settings.json` (project)
 * or `<agentDir>/settings.json` (global). No config → the extension loads
 * and stays silent. `--no-sounds` silences everything for one run; the
 * /sounds command mutes playback at runtime without touching settings.
 *
 * Best-effort contract: no handler ever throws; playback failures are
 * swallowed at every level.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultConfig, type EventTriggerName, resolveConfig, type SoundConfig } from "./config";
import { detectBackend, playSound, type SoundBackend } from "./player";
import {
	ElapsedTimer,
	pick,
	QuotaDetector,
	SettleOutcome,
	settleFiles,
	TurnErrorDedupe,
	turnSpecFires,
} from "./triggers";

/**
 * Runtime mute, held at MODULE scope on purpose: Pi re-invokes the
 * extension factory on every session load (new session, /resume, /fork)
 * while the extension cache keeps this module instance, so a
 * factory-closure `muted` would silently reset on each new session.
 * Module scope survives every session replacement while the cache is
 * intact; a true reload re-imports this module and un-mutes. Never
 * persisted to settings.
 */
let muted = false;

export default function piEventSounds(pi: ExtensionAPI): void {
	pi.registerFlag("no-sounds", {
		description: "Disable all pi-event-sounds playback for this run",
		type: "boolean",
		default: false,
	});

	// The flag value is captured, not re-read inside handlers: flags are
	// immutable after parse, and a captured `pi` must not be touched from
	// event handlers or timer callbacks after session replacement
	// (stale-runner errors). One nuance verified against the loader: the
	// factory runs BEFORE the CLI applies `--no-sounds` to the flag store
	// (applyExtensionFlagValues), so the factory-time read sees only the
	// default. The value is therefore re-captured at the head of every
	// session_start dispatch — the first event of each session, always on
	// the live `pi` — and handlers/timers use only the captured boolean.
	let noSounds = pi.getFlag("no-sounds") === true;

	// Backend detection probes PATH once per process (memoized in player.ts).
	const backend: SoundBackend = detectBackend();

	// Session-scoped config cache: loaded at factory time so handlers always
	// have a config to consult, refreshed on every session_start (before the
	// sessionStart trigger itself is evaluated). Handlers read the cache at
	// fire time, so a settings edit + new session flips behavior without a
	// restart and no per-event file I/O occurs.
	let config: SoundConfig = resolveConfigSafe();

	// Quota matcher is rebuilt whenever the config refreshes, because
	// quotaPatterns may change between sessions.
	let quotaDetector = new QuotaDetector(config.quotaPatterns, config.exhaustedPatterns);
	const turnError = new TurnErrorDedupe();
	const elapsedTimer = new ElapsedTimer();
	const settleOutcome = new SettleOutcome();

	function resolveConfigSafe(): SoundConfig {
		try {
			return resolveConfig(process.cwd(), getAgentDir());
		} catch {
			return defaultConfig();
		}
	}

	/** True when playback is allowed: enabled, no --no-sounds, not muted. */
	function active(): boolean {
		return config.enabled && !noSounds && !muted;
	}

	/** Fire one configured event trigger (random pick among its files). */
	function fire(name: EventTriggerName): void {
		if (!active()) return;
		const file = pick(config.events[name]);
		if (file) playSound(file, config.volume, backend);
	}

	pi.on("session_start", async () => {
		// Refresh BEFORE evaluating sessionStart so a settings edit taking
		// effect with this session governs the session-start sound too.
		noSounds = pi.getFlag("no-sounds") === true;
		config = resolveConfigSafe();
		quotaDetector = new QuotaDetector(config.quotaPatterns, config.exhaustedPatterns);
		turnError.reset();
		elapsedTimer.clear();
		settleOutcome.reset();
		fire("sessionStart");
	});

	pi.on("input", async () => {
		fire("promptSubmit");
	});

	pi.on("agent_start", async () => {
		// Re-arm the outcome latch per attempt: automatic retries and
		// compaction continuations re-enter the loop with a fresh
		// agent_start, so the last attempt's verdict wins.
		settleOutcome.reset();
		fire("agentStart");
		// Arm the elapsed timer for this run; the callback receives the fired
		// block (each block plays its own files) and reads the captured flag
		// boolean at fire time.
		elapsedTimer.arm(config, (spec) => {
			if (!active()) return;
			const file = pick(spec.files);
			if (file) playSound(file, config.volume, backend);
		});
	});

	// agent_end is the only lifecycle event carrying messages — record the
	// run's terminal outcome for the settle handler to consume.
	pi.on("agent_end", async (event) => {
		settleOutcome.noteAgentEnd(event.messages);
	});

	pi.on("agent_settled", async () => {
		elapsedTimer.clear();
		// Outcome-aware settle: failed → agentFailed (falls back to the
		// error file list), aborted → agentAborted, else agentSettled.
		const outcome = settleOutcome.take();
		if (!active()) return;
		const file = pick(settleFiles(config, outcome));
		if (file) playSound(file, config.volume, backend);
	});

	// Extension UI prompts only (ctx.ui.select/confirm/input/editor/custom);
	// built-in permission dialogs never emit ui_prompt_start.
	pi.on("ui_prompt_start", async () => {
		fire("question");
	});

	pi.on("tool_result", async (event) => {
		if (!event.isError) return;
		if (!turnError.claim()) return;
		fire("error");
	});

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		// Skip the detector entirely when neither quota trigger can produce a
		// sound — consulting it would consume the 5-second dedupe window for
		// nothing, suppressing a later legitimate fire after config refresh.
		if (config.events.quota.length === 0 && config.events.quotaExhausted.length === 0) return;
		const kind = quotaDetector.classify(message);
		if (kind && config.events[kind].length > 0) fire(kind);
	});

	pi.on("turn_start", async (event) => {
		// Dedupe state resets at every turn boundary.
		turnError.reset();
		if (!active()) return;
		// Each block fires its own files; matching blocks play independently.
		for (const spec of config.turns) {
			if (!turnSpecFires(event.turnIndex, spec)) continue;
			const file = pick(spec.files);
			if (file) playSound(file, config.volume, backend);
		}
	});

	pi.on("session_shutdown", async () => {
		elapsedTimer.clear();
	});

	// /sounds (alias /event-sounds): a session mute that is independent of
	// settings.json and of --no-sounds — it can only silence, never force
	// playback. One options object shared by both registered names; the
	// mute itself is module state (see `muted` above).
	const soundsCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "Mute or unmute pi-event-sounds for this session (toggle | on | off | status)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "on", label: "on", description: "Unmute sounds for this session" },
				{ value: "off", label: "off", description: "Mute sounds for this session" },
				{ value: "status", label: "status", description: "Report whether sounds are active and why" },
			];
			return items.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			// Best-effort reporting: notify when the UI is there, never throw.
			const notify = (message: string, type: "info" | "warning" = "info"): void => {
				try {
					ctx?.ui?.notify?.(message, type);
				} catch {
					// A notification must never throw out of the command.
				}
			};
			const arg = args.trim().toLowerCase();
			if (arg === "" || arg === "toggle") {
				muted = !muted;
				notify(muted ? "Sounds muted for this session" : "Sounds unmuted");
				return;
			}
			if (arg === "on") {
				muted = false;
				notify("Sounds unmuted");
				return;
			}
			if (arg === "off") {
				muted = true;
				notify("Sounds muted for this session");
				return;
			}
			if (arg === "status") {
				// Name the first responsible input: CLI flag, config, mute.
				if (noSounds) notify("Sounds off — disabled by --no-sounds", "warning");
				else if (!config.enabled) notify("Sounds off — sounds.enabled is false", "warning");
				else if (muted) notify("Sounds off — muted via /sounds", "warning");
				else notify("Sounds on");
				return;
			}
			notify("Usage: /sounds [toggle|on|off|status]", "warning");
		},
	};
	pi.registerCommand("sounds", soundsCommand);
	pi.registerCommand("event-sounds", soundsCommand);
}
