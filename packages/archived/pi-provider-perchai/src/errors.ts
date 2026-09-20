/** Perch API error codes observed in the perchai-cli bundle (set `a$r`). */
export type PerchErrorCode =
	| "provider_not_configured"
	| "api_error"
	| "timeout"
	| "parse_error"
	| "usage_limit_reached"
	| "starter_model_blocked"
	| "perch_surface_required"
	| "turn_rate_limited"
	| "client_update_required"
	| "promo_overflow_decision";

/** Codes that mean the turn is over and retrying this request cannot help. */
const TERMINAL_ERROR_CODES = new Set<PerchErrorCode>([
	"usage_limit_reached",
	"starter_model_blocked",
	"perch_surface_required",
	"turn_rate_limited",
	"client_update_required",
	"promo_overflow_decision",
]);

export class PerchError extends Error {
	readonly status: number | null;
	readonly errorCode: PerchErrorCode | null;
	readonly bodyText: string;
	/** True for failures that retries cannot fix. */
	readonly terminal: boolean;
	/** Raw response body, for debug logging of e.g. `perch_surface_required`. */
	readonly rawBody: string | null;

	constructor(options: {
		message: string;
		status?: number | null;
		errorCode?: PerchErrorCode | null;
		bodyText?: string;
		terminal?: boolean;
		rawBody?: string | null;
	}) {
		super(options.message);
		this.name = "PerchError";
		this.status = options.status ?? null;
		this.errorCode = options.errorCode ?? null;
		const errorCode = options.errorCode;
		this.terminal =
			options.terminal ?? (errorCode !== undefined && errorCode !== null && TERMINAL_ERROR_CODES.has(errorCode));
		this.bodyText = options.bodyText ?? options.message;
		this.rawBody = options.rawBody ?? null;
	}
}

const PERCH_ERROR_CODES = {
	provider_not_configured: true,
	api_error: true,
	timeout: true,
	parse_error: true,
	usage_limit_reached: true,
	starter_model_blocked: true,
	perch_surface_required: true,
	turn_rate_limited: true,
	client_update_required: true,
	promo_overflow_decision: true,
} as const satisfies Record<PerchErrorCode, true>;

function isPerchErrorCode(value: unknown): value is PerchErrorCode {
	return typeof value === "string" && value in PERCH_ERROR_CODES;
}

/** A parsed Perch failure: message, code, and the raw body for debugging. */
export interface PerchFailure {
	message: string;
	errorCode: PerchErrorCode | null;
	rawBody: string | null;
}

function preview(text: string): string {
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Parses a JSON or plain-text response body into a Perch failure shape. */
export function parsePerchFailure(body: string): PerchFailure {
	const rawBody = body;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			const obj = parsed as Record<string, unknown>;
			const codeValue = obj.errorCode ?? obj.errorCodeText ?? null;
			const message =
				typeof obj.error === "string"
					? obj.error
					: typeof obj.msg === "string"
						? obj.msg
						: typeof obj.message === "string"
							? obj.message
							: typeof obj.error_description === "string"
								? obj.error_description
								: `perch request failed (${preview(body)})`;
			return {
				message,
				errorCode: isPerchErrorCode(codeValue) ? codeValue : null,
				rawBody,
			};
		}
	} catch {
		// fall through to plain text
	}
	const text = body.trim();
	return {
		message: text.length > 0 ? text : "perch request failed (empty body)",
		errorCode: null,
		rawBody,
	};
}

/**
 * Enriches a raw Perch failure with actionable guidance keyed off the HTTP
 * status and error code (design error-mapping table). Callers throw
 * `PerchError` with the returned message; `rawBody` is kept for debug logging
 * of e.g. `perch_surface_required`.
 */
export function describePerchError(status: number, body: string): PerchFailure {
	const failure = parsePerchFailure(body);
	const code = failure.errorCode ?? deriveErrorCode(status, failure.message);
	return {
		message: enrichMessage(status, code, failure.message),
		errorCode: code,
		rawBody: failure.rawBody,
	};
}

/** Best-effort error code when the server body did not carry one. */
function deriveErrorCode(status: number, message: string): PerchErrorCode | null {
	if (/invalid_grant/i.test(message)) return "api_error";
	if (status === 403 && /upgrade to pro/i.test(message)) return "starter_model_blocked";
	if (status === 429) return "usage_limit_reached";
	return null;
}

/** Appends recovery guidance to the server's own message text. */
function enrichMessage(status: number, code: PerchErrorCode | null, message: string): string {
	switch (code) {
		case "starter_model_blocked":
			return (
				`perch: ${message} — this pinned model may have left the Starter pool; ` +
				"switch to perch/standard or re-run `pnpm run discover-models`."
			);
		case "usage_limit_reached":
			return `perch: ${message} — the monthly Starter allowance is exhausted; wait for the next period or add credits.`;
		case "turn_rate_limited":
			return `perch: ${message} — Perch turn rate limit; wait a moment and retry.`;
		case "perch_surface_required":
			return (
				`perch: ${message} — the request was rejected as a non-Perch surface, which is a mimicry bug in this extension; ` +
				"re-run with PERCH_DEBUG=1 to log the full request/response for a report."
			);
		case "client_update_required":
			return `perch: ${message} — the CLI version header was rejected; re-run \`pnpm run discover-models\` to refresh it.`;
		case "promo_overflow_decision":
			return `perch: ${message} — Perch promo capacity decision (v1 surfaces this as an error).`;
		default:
			break;
	}
	if (status === 401 || /invalid_grant/i.test(message)) {
		return `perch: credentials expired — re-authenticate with /login (server said: ${message}).`;
	}
	return message;
}
