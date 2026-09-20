import type { Model } from "@earendil-works/pi-ai";
import type { PerchAccount } from "./auth/perch-oauth.ts";
import { fetchAccount } from "./auth/perch-oauth.ts";
import { PERCH_CLI_UA } from "./cli-version.ts";
import { describePerchError, PerchError } from "./errors.ts";

/** Parsed shape of getApiKey()'s serialized credentials. */
export interface PerchStreamCredentials {
	access: string;
	appUrl: string;
}

export interface TurnTicket {
	ok: boolean;
	ticket?: string;
	runId?: string;
	enforced?: boolean;
}

interface AttributionCache {
	userId: string | null;
	workspaceId: string | null;
	fetchedAt: number;
}

/** Two retries with 1s/4s backoff (design §Error mapping). */
export const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 4000] as const;
const ATTRIBUTION_CACHE_MS = 10 * 60 * 1000;

/** Debug logging gated on PERCH_DEBUG=1 (design: log full body in debug). */
function debug(message: string): void {
	if (process.env.PERCH_DEBUG === "1") {
		console.error(`[perch] ${message}`);
	}
}

const attributionCache = new Map<string, AttributionCache>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new PerchError({ message: "Request was aborted", terminal: true }));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new PerchError({ message: "Request was aborted", terminal: true }));
			},
			{ once: true },
		);
	});
}

function isRetryableStatus(status: number): boolean {
	return status >= 500 && status < 600;
}

function authHeaders(access: string): Record<string, string> {
	return {
		Authorization: `Bearer ${access}`,
		"User-Agent": PERCH_CLI_UA,
	};
}

/**
 * Mints a turn ticket. Only *enforced* failures abort the turn; non-enforced
 * failures (including network errors and non-429 statuses) are tolerated and
 * the turn proceeds without a ticket, mirroring the CLI. Abort propagates.
 */
export async function mintTurnTicket(
	credentials: PerchStreamCredentials,
	signal?: AbortSignal,
): Promise<TurnTicket | null> {
	let response: Response;
	try {
		response = await fetch(`${credentials.appUrl}/api/perch-terminal/turn-ticket`, {
			method: "POST",
			headers: {
				...authHeaders(credentials.access),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ surface: "cli", profile: "standard" }),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		// Network mint failure: tolerated, proceed without a ticket.
		return null;
	}
	const text = await response.text();
	if (!response.ok) {
		const failure = describePerchError(response.status, text);
		// Fail only when the server enforces the ticket gate.
		if (bodyBoolean(text, "enforced")) {
			throw new PerchError({
				message: failure.message,
				errorCode: failure.errorCode,
				rawBody: failure.rawBody,
				status: response.status,
			});
		}
		// Non-enforced ticket failure: tolerated, proceed without a ticket.
		return null;
	}
	let parsed: Partial<TurnTicket>;
	try {
		parsed = JSON.parse(text) as Partial<TurnTicket>;
	} catch {
		// malformed ticket response: proceed without a ticket
		return null;
	}
	// A 200 carrying enforced:true but no usable ticket is an enforced failure.
	if (parsed.enforced === true && !(parsed.ok && typeof parsed.ticket === "string")) {
		const failure = describePerchError(response.status, text);
		throw new PerchError({
			message: failure.message,
			errorCode: failure.errorCode,
			rawBody: failure.rawBody,
			status: response.status,
		});
	}
	if (parsed.ok && typeof parsed.ticket === "string") {
		return {
			ok: true,
			ticket: parsed.ticket,
			runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
			enforced: typeof parsed.enforced === "boolean" ? parsed.enforced : undefined,
		};
	}
	return null;
}

function bodyBoolean(body: string, field: string): boolean {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		return parsed[field] === true;
	} catch {
		return false;
	}
}

/** Cached (10 min) account fetch for attribution ids; null when unavailable. */
async function getAttribution(
	credentials: PerchStreamCredentials,
	signal?: AbortSignal,
): Promise<{ userId: string | null; workspaceId: string | null } | null> {
	const cached = attributionCache.get(credentials.access);
	if (cached && Date.now() - cached.fetchedAt < ATTRIBUTION_CACHE_MS) {
		return cached;
	}
	try {
		const account: PerchAccount = await fetchAccount(credentials.access, credentials.appUrl, signal);
		const session = account.session ?? {};
		const entry: AttributionCache = {
			userId: typeof session.userId === "string" ? session.userId : null,
			workspaceId: typeof session.workspaceId === "string" ? session.workspaceId : null,
			fetchedAt: Date.now(),
		};
		attributionCache.set(credentials.access, entry);
		return entry;
	} catch {
		// Attribution is omitted when the account fetch fails (server tolerates null).
		return null;
	}
}

function makeRunId(): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `cli-turn-${Date.now()}-${random}`;
}

export interface PostModelCallOptions {
	onPayload?: (payload: unknown, model: Model<string>) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (
		response: { status: number; headers: Record<string, string> },
		model: Model<string>,
	) => void | Promise<void>;
	signal?: AbortSignal;
}

export interface ModelCallRequest {
	request: {
		lane: "chat";
		messages: unknown[];
		tools?: unknown[];
		toolChoice?: "auto";
		temperature?: number;
		maxOutputTokens?: number;
	};
	runId: string;
	lane: "chat";
	strictManual: false;
	preferredModelId: null;
	avoidModelIds: [];
	attribution: {
		userId: string | null;
		workspaceId: string | null;
		runId: string;
		lane: "chat";
		source: "cli";
		billingMultiplier: null;
	} | null;
	clientSurface: "cli";
	manualModelOptionId?: string;
	roostModelChoice: "standard" | "standard_max";
	roostReasoning: boolean;
	effort: {
		level: "off" | "low" | "medium" | "high" | "xhigh" | "max";
		orchestration: false;
	};
}

/**
 * POSTs the model call with up to 2 retries (1s, 4s) on 5xx/network errors,
 * reusing the same turn ticket across retries.
 */
export async function postModelCall(
	credentials: PerchStreamCredentials,
	requestBody: ModelCallRequest,
	model: Model<string>,
	options: PostModelCallOptions = {},
): Promise<Response> {
	const ticket = await mintTurnTicket(credentials, options.signal);
	// The turn-ticket runId identifies the turn server-side; mirror it into
	// attribution.runId so the two agree (bundle `Mv` behavior).
	if (ticket?.runId) {
		requestBody.runId = ticket.runId;
		if (requestBody.attribution) {
			requestBody.attribution = { ...requestBody.attribution, runId: ticket.runId };
		}
	}

	// onPayload fires once per stream (built-in semantics); the resulting body is
	// reused across retries. onResponse fires once for the response we return.
	const headers: Record<string, string> = {
		...authHeaders(credentials.access),
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(ticket?.ticket ? { "x-perch-turn-ticket": ticket.ticket } : {}),
	};
	const replacement = await options.onPayload?.(requestBody, model);
	if (replacement !== undefined) {
		requestBody = replacement as ModelCallRequest;
	}

	let lastError: PerchError | null = null;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1], options.signal);
		}
		let response: Response;
		try {
			// Only the network fetch lives in the retry catch; HTTP error
			// statuses are handled below so non-retryable errors are never
			// swallowed by the catch.
			response = await fetch(`${credentials.appUrl}/api/perch-terminal/model-call`, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: options.signal,
			});
		} catch (error) {
			if (error instanceof PerchError && error.terminal) {
				throw error;
			}
			// Network errors (fetch rejects): retryable.
			lastError = new PerchError({
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		// Fire onResponse as soon as headers arrive, for every response.
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (response.ok) {
			return response;
		}
		const text = await response.text();
		const failure = describePerchError(response.status, text);
		const perchError = new PerchError({
			message: failure.message,
			errorCode: failure.errorCode,
			rawBody: failure.rawBody,
			status: response.status,
		});
		if (perchError.errorCode === "perch_surface_required") {
			debug(`perch_surface_required raw body: ${failure.rawBody ?? text}`);
		}
		if (perchError.terminal) {
			throw perchError;
		}
		if (isRetryableStatus(response.status)) {
			lastError = perchError;
			continue;
		}
		throw perchError;
	}
	throw lastError ?? new PerchError({ message: "perch: model call failed after retries" });
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		record[key] = value;
	}
	return record;
}

/** Builds the full model-call body (design §Model call). */
export async function buildModelCallRequest(
	credentials: PerchStreamCredentials,
	converted: {
		messages: unknown[];
		tools?: unknown[];
		toolChoice?: "auto";
	},
	effort: {
		level: ModelCallRequest["effort"]["level"];
		roostReasoning: boolean;
	},
	roostModelChoice: ModelCallRequest["roostModelChoice"],
	manualModelOptionId: string | undefined,
	temperature?: number,
	maxOutputTokens?: number,
	signal?: AbortSignal,
): Promise<ModelCallRequest> {
	const attribution = await getAttribution(credentials, signal);
	const runId = makeRunId();
	return {
		request: {
			lane: "chat",
			messages: converted.messages,
			tools: converted.tools,
			toolChoice: converted.toolChoice,
			temperature,
			maxOutputTokens,
		},
		runId,
		lane: "chat",
		strictManual: false,
		preferredModelId: null,
		avoidModelIds: [],
		attribution:
			attribution !== null
				? {
						userId: attribution.userId,
						workspaceId: attribution.workspaceId,
						runId,
						lane: "chat",
						source: "cli",
						billingMultiplier: null,
					}
				: null,
		clientSurface: "cli",
		...(manualModelOptionId ? { manualModelOptionId } : {}),
		roostModelChoice: roostModelChoice,
		roostReasoning: effort.roostReasoning,
		effort: { level: effort.level, orchestration: false },
	};
}
