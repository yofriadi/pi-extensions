import { existsSync } from "node:fs";
import { open as openAsync, stat as statAsync } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getForegroundDeliveryBarrier } from "./delivery-barrier.ts";
import {
	DELIVERY_RETRY_INTERVAL_KEY,
	deliveredRunIds,
	inflightDelivery,
	pendingDeliveries,
	runtime,
	wakeInflightByParent,
} from "./state.ts";
import type { DeliveryWaitKind } from "./types.ts";

const ACTIVE_COMPLETION_RUNTIME_KEY = Symbol.for("pi-subagent-herdr/active-completion-runtime");
const COMPLETION_RUNTIME_GENERATION_KEY = Symbol.for("pi-subagent-herdr/completion-runtime-generation");
const DELIVERY_PUMP_KEY = Symbol.for("pi-subagent-herdr/delivery-pump");
const STREAM_ACK_MAX_WAIT_MS = 60 * 60_000;

export const MAX_PENDING_DELIVERY_ATTEMPTS = 8;
export const DEFERRED_DELIVERY_MAX_MS = 60 * 60_000;
export const PRIMARY_DELIVERY_GRACE_MS = 8000;
export const WAKE_MESSAGE =
	"[pi-subagent-herdr] Automated notice: one or more background subagent results were delivered to this session. Review the latest subagent_result messages and continue.";

export interface ActiveCompletionRuntime {
	api: ExtensionAPI;
	parentSessionId: string;
	generation: number;
}

type DeliveryOptions = {
	sessionFile?: string;
	expectedRunId?: string;
	graceMs?: number;
	onWait?: (kind: DeliveryWaitKind) => void;
};

type DeliveryAttempt = {
	runId?: string;
	outcome: "deduped" | "sent";
	ackPromise?: Promise<void>;
	mirroredAck?: Promise<void>;
	wakeRequested: boolean;
	queuedIntoStream: boolean;
	sentAtMs: number;
};

/** Typed condition: no session-bound runtime matches the target session. */
export class SessionRuntimeUnavailableError extends Error {
	constructor(parentSessionId: string) {
		super(`No active session-bound extension runtime for parent session ${parentSessionId}.`);
		this.name = "SessionRuntimeUnavailableError";
	}
}

export function isSessionRuntimeUnavailable(error: unknown): boolean {
	return error instanceof SessionRuntimeUnavailableError;
}

/** Resolve the active completion runtime, rejecting absent or mismatched sessions. */
export function requireActiveCompletionRuntime(parentSessionId: string): ActiveCompletionRuntime {
	const record = (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] as ActiveCompletionRuntime | undefined;
	if (!record || record.parentSessionId !== parentSessionId)
		throw new SessionRuntimeUnavailableError(parentSessionId);
	return record;
}

/** Best-effort active-runtime lookup for optional sends. */
export function resolveActiveCompletionRuntime(parentSessionId: string): ActiveCompletionRuntime | undefined {
	const record = (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] as ActiveCompletionRuntime | undefined;
	return record?.parentSessionId === parentSessionId ? record : undefined;
}

export function activateCompletionRuntime(api: ExtensionAPI, parentSessionId: string): ActiveCompletionRuntime {
	const globals = globalThis as any;
	const generation = ((globals[COMPLETION_RUNTIME_GENERATION_KEY] as number | undefined) ?? 0) + 1;
	globals[COMPLETION_RUNTIME_GENERATION_KEY] = generation;
	const record: ActiveCompletionRuntime = { api, parentSessionId, generation };
	globals[ACTIVE_COMPLETION_RUNTIME_KEY] = record;
	return record;
}

/** Clears only a runtime record still owned by this extension instance. */
export function deactivateCompletionRuntime(record: ActiveCompletionRuntime | undefined): void {
	if (record && (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY] === record) {
		delete (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY];
	}
}

/** Test-only reset for repeated in-process extension factory invocations. */
export function resetActiveCompletionRuntimeForTest(): void {
	delete (globalThis as any)[ACTIVE_COMPLETION_RUNTIME_KEY];
}

/**
 * Persist a background completion message, then best-effort wake the parent.
 * The legacy first parameter remains for compatibility; runtime resolution is
 * always session-bound and occurs at send time.
 */
export async function deliverBackgroundMessage(
	_pi: ExtensionAPI | undefined,
	parentSessionId: string,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: DeliveryOptions = {},
): Promise<void> {
	requireActiveCompletionRuntime(parentSessionId);
	const attempt = createDeliveryAttempt(options.expectedRunId);
	const reportWait = deliveryWaitReporter(options.onWait);
	const barrier = getForegroundDeliveryBarrier(parentSessionId);
	if (barrier.isActive()) reportWait("barrier");
	await barrier.deliver((wake) => deliverWithinBarrier(parentSessionId, message, options, attempt, wake, reportWait));
	await settleDeliveryAttempt(attempt);
}

function createDeliveryAttempt(runId: string | undefined): DeliveryAttempt {
	return { runId, outcome: "deduped", wakeRequested: false, queuedIntoStream: false, sentAtMs: 0 };
}

function deliveryWaitReporter(onWait: DeliveryOptions["onWait"]): (kind: DeliveryWaitKind) => void {
	return (kind) => {
		try {
			onWait?.(kind);
		} catch {
			// Presentation observability must not retry an accepted send.
		}
	};
}

async function deliverWithinBarrier(
	parentSessionId: string,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: DeliveryOptions,
	attempt: DeliveryAttempt,
	wake: boolean,
	reportWait: (kind: DeliveryWaitKind) => void,
): Promise<void> {
	if (await isDuplicateDelivery(message, options, attempt)) return;
	const activeRuntime = sendDeliveryMessage(parentSessionId, message, attempt, wake);
	trackDeliveryAcknowledgement(message, options, attempt);
	wakeDeliveredParent(parentSessionId, activeRuntime, attempt);
	reportWait(attempt.queuedIntoStream ? "turn-boundary" : "verifying");
}

async function isDuplicateDelivery(
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: DeliveryOptions,
	attempt: DeliveryAttempt,
): Promise<boolean> {
	const { runId } = attempt;
	if (runId && deliveredRunIds.has(runId)) return markDeduped(attempt);
	if (runId && inflightDelivery.has(runId)) {
		attempt.mirroredAck = inflightDelivery.get(runId);
		return markDeduped(attempt);
	}
	if (await deliveryAlreadyPersisted(message, options, runId)) {
		if (runId) deliveredRunIds.add(runId);
		return markDeduped(attempt);
	}
	return false;
}

function markDeduped(attempt: DeliveryAttempt): true {
	attempt.outcome = "deduped";
	return true;
}

async function deliveryAlreadyPersisted(
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: DeliveryOptions,
	runId: string | undefined,
): Promise<boolean> {
	return Boolean(
		options.sessionFile && runId && (await deliveryEntryExists(options.sessionFile, runId, message.customType)),
	);
}

function sendDeliveryMessage(
	parentSessionId: string,
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	attempt: DeliveryAttempt,
	wake: boolean,
): ActiveCompletionRuntime {
	const activeRuntime = requireActiveCompletionRuntime(parentSessionId);
	attempt.queuedIntoStream = runtime.parentActivity.streaming;
	attempt.sentAtMs = Date.now();
	activeRuntime.api.sendMessage(message, { deliverAs: "steer" });
	attempt.outcome = "sent";
	attempt.wakeRequested = wake;
	return activeRuntime;
}

function trackDeliveryAcknowledgement(
	message: Parameters<ExtensionAPI["sendMessage"]>[0],
	options: DeliveryOptions,
	attempt: DeliveryAttempt,
): void {
	if (!attempt.runId || !options.sessionFile) return;
	const runId = attempt.runId;
	attempt.ackPromise = acknowledgeDelivery(options.sessionFile, runId, message.customType, {
		graceMs: options.graceMs ?? PRIMARY_DELIVERY_GRACE_MS,
		queuedIntoStream: attempt.queuedIntoStream,
	}).then(
		() => {
			deliveredRunIds.add(runId);
			inflightDelivery.delete(runId);
		},
		(error: unknown) => {
			inflightDelivery.delete(runId);
			throw error;
		},
	);
	inflightDelivery.set(runId, attempt.ackPromise);
}

function wakeDeliveredParent(
	parentSessionId: string,
	activeRuntime: ActiveCompletionRuntime,
	attempt: DeliveryAttempt,
): void {
	if (attempt.queuedIntoStream) return;
	const activity = runtime.parentActivity;
	const currentTurnAlreadySeesIt = activity.streaming && activity.turnStartedAtMs >= attempt.sentAtMs;
	if (attempt.wakeRequested || !currentTurnAlreadySeesIt) wakeParent(parentSessionId, activeRuntime);
}

async function settleDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
	if (attempt.outcome === "deduped") {
		if (attempt.mirroredAck) await attempt.mirroredAck;
		return;
	}
	if (attempt.ackPromise) await attempt.ackPromise;
	else if (attempt.runId) deliveredRunIds.add(attempt.runId);
}

export async function acknowledgeDelivery(
	sessionFile: string,
	runId: string,
	customType: string,
	options: { graceMs: number; queuedIntoStream: boolean; streamWaitMs?: number },
): Promise<void> {
	try {
		await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
		return;
	} catch (error) {
		if (!options.queuedIntoStream) throw error;
	}
	const streamDeadline = Date.now() + (options.streamWaitMs ?? STREAM_ACK_MAX_WAIT_MS);
	while (runtime.parentActivity.streaming && Date.now() < streamDeadline) {
		try {
			await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
			return;
		} catch {
			// A queued steer persists on a turn boundary; keep waiting while streaming.
		}
	}
	await verifyDeliveryPersisted(sessionFile, runId, customType, { graceMs: options.graceMs });
}

export function wakeParent(parentSessionId: string, expectedRecord?: ActiveCompletionRuntime): void {
	const record = resolveActiveCompletionRuntime(parentSessionId);
	if (!record || (expectedRecord && record !== expectedRecord) || wakeInflightByParent.has(parentSessionId)) return;
	wakeInflightByParent.add(parentSessionId);
	try {
		record.api.sendUserMessage(WAKE_MESSAGE, { deliverAs: "followUp" });
	} catch {
		// The persisted completion remains discoverable on the next turn.
	}
	const timer = setTimeout(() => wakeInflightByParent.delete(parentSessionId), 30_000);
	(timer as unknown as { unref?: () => void }).unref?.();
}

export async function deliveryEntryExists(
	sessionFile: string,
	expectedRunId: string,
	customType: string,
): Promise<boolean> {
	return (await findDeliveryEntry(sessionFile, expectedRunId, customType)) !== null;
}

function canParseJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

export async function verifyDeliveryPersisted(
	sessionFile: string,
	expectedRunId: string,
	customType: string,
	options: { graceMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const graceMs = options.graceMs ?? 5000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (await deliveryEntryExists(sessionFile, expectedRunId, customType)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Delivery verification failed: ${customType} message with run ID ${expectedRunId} not persisted within ${graceMs}ms`,
	);
}

/** Scan up to the 128 latest complete JSONL records for a matching custom event. */
export async function findDeliveryEntry(
	sessionFile: string,
	expectedRunId: string,
	customType: string,
): Promise<any | null> {
	if (!existsSync(sessionFile)) return null;
	try {
		const lines = await readDeliveryTailLines(sessionFile);
		return findDeliveryRecord(lines, expectedRunId, customType);
	} catch {
		// A transient read failure is retried by the caller's bounded verifier.
		return null;
	}
}

async function readDeliveryTailLines(sessionFile: string): Promise<string[]> {
	const { size } = await statAsync(sessionFile);
	const fd = await openAsync(sessionFile, "r");
	try {
		return completeDeliveryTailLines(await readDeliveryTail(fd, size));
	} finally {
		await fd.close();
	}
}

async function readDeliveryTail(fd: Awaited<ReturnType<typeof openAsync>>, size: number): Promise<string> {
	let readSize = Math.min(size, 32_768);
	let offset = Math.max(0, size - readSize);
	let tailContent = "";
	for (let attempt = 0; attempt < 6; attempt++) {
		tailContent = await readDeliveryWindow(fd, readSize, offset);
		// Count only complete records: window boundaries can split a record and a
		// concurrently-appended file can end mid-record. Dropping both partials
		// keeps the 128-record budget exact so a target record is never pushed
		// out of the window by a fragment.
		const lines = completeDeliveryTailLines(tailContent);
		if (lines.length >= 128 || offset === 0) return lines.slice(-128).join("\n");
		readSize = Math.min(1_048_576, readSize * 2);
		offset = Math.max(0, size - readSize);
	}
	return tailContent;
}

async function readDeliveryWindow(
	fd: Awaited<ReturnType<typeof openAsync>>,
	readSize: number,
	offset: number,
): Promise<string> {
	const buffer = Buffer.alloc(readSize);
	const { bytesRead } = await fd.read(buffer, 0, readSize, offset);
	return buffer.subarray(0, bytesRead).toString("utf8");
}

function completeDeliveryTailLines(content: string): string[] {
	const lines = nonBlankLines(content);
	if (lines.length === 0) return lines;
	// Drop a head fragment (window started mid-record) and a trailing fragment
	// (file being appended without a final newline); keep everything else even
	// if unparseable — record matching skips corrupt lines individually.
	const headComplete = canParseJson(lines[0]) ? lines : lines.slice(1);
	const last = headComplete[headComplete.length - 1];
	return canParseJson(last) ? headComplete : headComplete.slice(0, -1);
}

function nonBlankLines(content: string): string[] {
	return content.split("\n").filter((line) => line.trim());
}

function findDeliveryRecord(lines: string[], expectedRunId: string, customType: string): any | null {
	for (const line of lines.slice(-128)) {
		const record = parseDeliveryRecord(line);
		if (record && recordMatchesDelivery(record, expectedRunId, customType)) return record;
	}
	return null;
}

function parseDeliveryRecord(line: string): any | undefined {
	try {
		return JSON.parse(line);
	} catch {
		// Concurrent writes may leave partial or malformed tail records.
		return undefined;
	}
}

function recordMatchesDelivery(record: any, expectedRunId: string, customType: string): boolean {
	return [record.message, record].some((candidate) => deliveryCandidateMatches(candidate, expectedRunId, customType));
}

function deliveryCandidateMatches(candidate: any, expectedRunId: string, customType: string): boolean {
	if (!candidate || typeof candidate !== "object" || candidate.customType !== customType) return false;
	const details = candidate.details ?? candidate.data?.details;
	return details?.id === expectedRunId;
}

export function queuePendingDeliveryWithVerification(
	id: string,
	parentSessionId: string,
	message: any,
	error: unknown,
	options: { sessionFile?: string; expectedRunId?: string } = {},
	attempts = 0,
): void {
	const existing = pendingDeliveries.get(id);
	const runtimeUnavailable = isSessionRuntimeUnavailable(error);
	const now = Date.now();
	pendingDeliveries.set(id, {
		id,
		parentSessionId,
		message,
		attempts,
		delivering: false,
		generation: (existing?.generation ?? 0) + 1,
		nextRetryAt: now + Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)),
		lastError: error instanceof Error ? error.message : String(error),
		sessionFile: options.sessionFile,
		expectedRunId: options.expectedRunId,
		...(runtimeUnavailable ? { deferredSince: existing?.deferredSince ?? now } : {}),
	});
	startDeliveryRetry();
}

/** The local pump remains inside this owner and moves only with its retry loop. */
export async function retryPendingDeliveries(): Promise<void> {
	const globals = globalThis as any;
	const existingPump = globals[DELIVERY_PUMP_KEY] as Promise<void> | undefined;
	if (existingPump) return existingPump;
	return trackPendingDeliveryPump(globals);
}

function trackPendingDeliveryPump(globals: any): Promise<void> {
	let trackedPump!: Promise<void>;
	trackedPump = processPendingDeliveries().finally(() => {
		if (globals[DELIVERY_PUMP_KEY] === trackedPump) delete globals[DELIVERY_PUMP_KEY];
	});
	globals[DELIVERY_PUMP_KEY] = trackedPump;
	return trackedPump;
}

async function processPendingDeliveries(): Promise<void> {
	for (const pending of Array.from(pendingDeliveries.values())) await processPendingDelivery(pending);
}

async function processPendingDelivery(pending: any): Promise<void> {
	if (discardSuppressedDelivery(pending)) return;
	const now = Date.now();
	if (shouldSkipPendingDelivery(pending, now)) return;
	if (expireDeferredDelivery(pending, now)) return;
	pending.delivering = true;
	await deliverPendingEntry(pending);
}

function discardSuppressedDelivery(pending: any): boolean {
	if (!getForegroundDeliveryBarrier(pending.parentSessionId).isSuppressed()) return false;
	pendingDeliveries.delete(pending.id);
	return true;
}

function shouldSkipPendingDelivery(pending: any, now: number): boolean {
	return pending.exhausted || pending.delivering || pending.nextRetryAt > now;
}

function expireDeferredDelivery(pending: any, now: number): boolean {
	if (pending.deferredSince === undefined || now - pending.deferredSince < DEFERRED_DELIVERY_MAX_MS) return false;
	pending.exhausted = true;
	pending.exhaustionCause = "deferral";
	pending.lastError = `No active session-bound runtime for ${Math.round((now - pending.deferredSince) / 1000)}s (deferral budget exceeded). Last: ${pending.lastError ?? "runtime unavailable"}`;
	return true;
}

async function deliverPendingEntry(pending: any): Promise<void> {
	const generation = pending.generation;
	try {
		await deliverBackgroundMessage(undefined, pending.parentSessionId, pending.message, {
			sessionFile: pending.sessionFile,
			expectedRunId: pending.expectedRunId,
		});
		removeDeliveredPendingEntry(pending.id, generation);
	} catch (error) {
		recordPendingDeliveryFailure(pending.id, generation, error);
	}
}

function removeDeliveredPendingEntry(id: string, generation: number): void {
	if (pendingDeliveries.get(id)?.generation === generation) pendingDeliveries.delete(id);
}

function recordPendingDeliveryFailure(id: string, generation: number, error: unknown): void {
	const current = pendingDeliveries.get(id);
	if (!current || current.generation !== generation) return;
	current.delivering = false;
	if (isSessionRuntimeUnavailable(error)) {
		deferPendingDelivery(current, error);
		return;
	}
	retryPendingDelivery(current, error);
}

function deferPendingDelivery(pending: any, error: unknown): void {
	pending.deferredSince ??= Date.now();
	pending.lastError = errorMessage(error);
	pending.nextRetryAt = Date.now() + 500;
}

function retryPendingDelivery(pending: any, error: unknown): void {
	delete pending.deferredSince;
	pending.attempts++;
	pending.lastError = errorMessage(error);
	pending.exhausted = pending.attempts >= MAX_PENDING_DELIVERY_ATTEMPTS;
	if (pending.exhausted) pending.exhaustionCause = "attempts";
	pending.nextRetryAt = Date.now() + retryDelay(pending.attempts);
}

function retryDelay(attempts: number): number {
	return Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function startDeliveryRetry(): void {
	const globals = globalThis as any;
	if (globals[DELIVERY_RETRY_INTERVAL_KEY]) return;
	const interval = setInterval(() => {
		void retryPendingDeliveries().catch(() => undefined);
		if (
			pendingDeliveries.size === 0 ||
			Array.from(pendingDeliveries.values()).every((pending) => pending.exhausted)
		) {
			if (globals[DELIVERY_RETRY_INTERVAL_KEY] === interval) {
				clearInterval(interval);
				globals[DELIVERY_RETRY_INTERVAL_KEY] = null;
			}
		}
	}, 1000);
	globals[DELIVERY_RETRY_INTERVAL_KEY] = interval;
}

export function stopDeliveryRetry(): void {
	const globals = globalThis as any;
	const interval = globals[DELIVERY_RETRY_INTERVAL_KEY] as ReturnType<typeof setInterval> | null | undefined;
	if (interval) clearInterval(interval);
	globals[DELIVERY_RETRY_INTERVAL_KEY] = null;
}
