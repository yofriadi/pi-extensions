/**
 * pi-event-sounds — configurable sound effects for pi-coding-agent.
 *
 * Plays user-configured sound files on Pi lifecycle events and derived
 * triggers: session start, prompt submit, agent start/settled, extension
 * questions, tool errors (per-turn dedupe), provider quota/rate-limit
 * responses, turn milestones, and elapsed-time reminders. Multiple files
 * per trigger → random pick per fire.
 *
 * Configuration lives under a `sounds` key in `.pi/settings.json` (project)
 * or `<agentDir>/settings.json` (global). No config → the extension loads
 * and stays silent. `--no-sounds` silences everything for one run.
 *
 * Best-effort contract: no handler ever throws; playback failures are
 * swallowed at every level.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultConfig, type EventTriggerName, resolveConfig, type SoundConfig } from "./config";
import { detectBackend, playSound, type SoundBackend } from "./player";
import { ElapsedTimer, isTurnMilestone, pick, QuotaDetector, TurnErrorDedupe } from "./triggers";

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

	function resolveConfigSafe(): SoundConfig {
		try {
			return resolveConfig(process.cwd(), getAgentDir());
		} catch {
			return defaultConfig();
		}
	}

	/** True when playback is allowed: config enabled and no --no-sounds. */
	function active(): boolean {
		return config.enabled && !noSounds;
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
		fire("sessionStart");
	});

	pi.on("input", async () => {
		fire("promptSubmit");
	});

	pi.on("agent_start", async () => {
		fire("agentStart");
		// Arm the elapsed timer for this run; the callback reads the cached
		// config (and only the captured flag boolean) at fire time.
		elapsedTimer.arm(config, () => {
			if (!active()) return;
			const elapsed = config.elapsed;
			if (!elapsed) return;
			const file = pick(elapsed.files);
			if (file) playSound(file, config.volume, backend);
		});
	});

	pi.on("agent_settled", async () => {
		elapsedTimer.clear();
		fire("agentSettled");
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
		const turns = config.turns;
		if (!turns || !isTurnMilestone(event.turnIndex, turns.every)) return;
		if (!active()) return;
		const file = pick(turns.files);
		if (file) playSound(file, config.volume, backend);
	});

	pi.on("session_shutdown", async () => {
		elapsedTimer.clear();
	});
}
