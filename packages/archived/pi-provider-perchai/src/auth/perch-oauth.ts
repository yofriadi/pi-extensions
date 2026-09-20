import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { PerchError, parsePerchFailure } from "../errors.ts";
import { startLoopbackCallback } from "../vendor/loopback.ts";
import { challenge, randomVerifier } from "../vendor/pkce.ts";

/** How long the auth-config fetch is cached in memory. */
const CONFIG_CACHE_MS = 15 * 60 * 1000;
/** Skew buffer subtracted from token expiry so refresh happens early. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** How long to wait for the browser redirect before failing login. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Provider preference order (mirrors the CLI's). */
const PROVIDER_PREFERENCE = ["google", "github"] as const;

export interface PerchAuthConfig {
	appUrl: string;
	supabaseUrl: string;
	supabaseAnonKey: string;
	providers: string[];
}

/** Session object nested inside the /api/perchai/account response. */
export interface PerchAccountSession {
	tierSelectionRequired?: boolean;
	userId?: string;
	workspaceId?: string;
	planCode?: string;
	planName?: string;
	membershipRole?: string;
	entitlements?: unknown[];
}

/** Top-level /api/perchai/account response (verified against the CLI bundle). */
export interface PerchAccount {
	ok?: boolean;
	session?: PerchAccountSession;
	usageMeter?: unknown;
	creditBalancePt?: number;
}

export interface PerchCredentials extends OAuthCredentials {
	access: string;
	refresh: string;
	expires: number;
	email?: string;
	userId?: string;
	appUrl: string;
}

interface SupabaseTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	expires_at?: number;
	user?: { id?: string; email?: string };
	error?: string;
	error_description?: string;
}

let configCache: { config: PerchAuthConfig; fetchedAt: number } | null = null;

/** Fetches (and caches for 15 minutes) the CLI auth config from the app. */
export async function fetchAuthConfig(appUrl: string, signal?: AbortSignal): Promise<PerchAuthConfig> {
	if (configCache && Date.now() - configCache.fetchedAt < CONFIG_CACHE_MS) {
		return configCache.config;
	}
	const response = await fetch(`${appUrl}/api/perch-terminal/cli-auth/config`, {
		headers: { Accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		const failure = parsePerchFailure(await response.text());
		throw new PerchError({
			...failure,
			status: response.status,
			message: `perch: auth config fetch failed (${response.status}): ${failure.message}`,
		});
	}
	const body = (await response.json()) as Partial<PerchAuthConfig> & { ok?: boolean };
	if (typeof body.supabaseUrl !== "string" || typeof body.supabaseAnonKey !== "string") {
		throw new PerchError({ message: "perch: auth config response missing supabaseUrl/supabaseAnonKey" });
	}
	const config: PerchAuthConfig = {
		appUrl: typeof body.appUrl === "string" ? body.appUrl : appUrl,
		supabaseUrl: body.supabaseUrl,
		supabaseAnonKey: body.supabaseAnonKey,
		providers: Array.isArray(body.providers) ? body.providers.filter((p) => typeof p === "string") : [],
	};
	configCache = { config, fetchedAt: Date.now() };
	return config;
}

/** Test seam: replaces the cached config. */
export function setAuthConfigCache(config: PerchAuthConfig | null, fetchedAt = Date.now()): void {
	configCache = config === null ? null : { config, fetchedAt };
}

function pickProvider(providers: string[]): string {
	for (const preferred of PROVIDER_PREFERENCE) {
		if (providers.includes(preferred)) {
			return preferred;
		}
	}
	const first = providers[0];
	if (first) {
		return first;
	}
	throw new PerchError({ message: "perch: auth config lists no login providers" });
}

function supabaseTokenUrl(supabaseUrl: string, grantType: "pkce" | "refresh_token"): string {
	return `${supabaseUrl}/auth/v1/token?grant_type=${grantType}`;
}

function supabaseHeaders(config: PerchAuthConfig): Record<string, string> {
	return {
		apikey: config.supabaseAnonKey,
		Authorization: `Bearer ${config.supabaseAnonKey}`,
		"Content-Type": "application/json",
	};
}

async function exchangeCode(
	config: PerchAuthConfig,
	authCode: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<SupabaseTokenResponse> {
	const response = await fetch(supabaseTokenUrl(config.supabaseUrl, "pkce"), {
		method: "POST",
		headers: supabaseHeaders(config),
		body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const failure = parsePerchFailure(text);
		throw new PerchError({
			...failure,
			status: response.status,
			message: `perch: token exchange failed (${response.status}): ${failure.message}`,
		});
	}
	return JSON.parse(text) as SupabaseTokenResponse;
}

/** Refreshes the Supabase session, rotating the refresh token when given. */
export async function refreshTokens(
	refreshToken: string,
	appUrl: string,
	signal?: AbortSignal,
): Promise<PerchCredentials> {
	const config = await fetchAuthConfig(appUrl, signal);
	const response = await fetch(supabaseTokenUrl(config.supabaseUrl, "refresh_token"), {
		method: "POST",
		headers: supabaseHeaders(config),
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const failure = parsePerchFailure(text);
		const invalidGrant = failure.errorCode === null && /invalid_grant/i.test(failure.message);
		throw new PerchError({
			...failure,
			status: response.status,
			message: invalidGrant
				? `perch: session invalidated (refresh rejected). Re-authenticate with /login (or re-import the perch CLI session). Original: ${failure.message}`
				: `perch: token refresh failed (${response.status}): ${failure.message}`,
		});
	}
	const body = JSON.parse(text) as SupabaseTokenResponse;
	const access = body.access_token;
	if (!access) {
		throw new PerchError({ message: "perch: refresh response missing access_token" });
	}
	const refresh = body.refresh_token ?? refreshToken;
	return {
		access,
		refresh,
		expires: computeExpiry(body),
		email: body.user?.email,
		userId: body.user?.id,
		appUrl,
	};
}

function computeExpiry(body: SupabaseTokenResponse): number {
	const base = body.expires_at !== undefined ? body.expires_at * 1000 : Date.now() + (body.expires_in ?? 0) * 1000;
	return base - EXPIRY_SKEW_MS;
}

/** GET {appUrl}/api/perchai/account (Bearer) — plan state and attribution ids. */
export async function fetchAccount(accessToken: string, appUrl: string, signal?: AbortSignal): Promise<PerchAccount> {
	const response = await fetch(`${appUrl}/api/perchai/account`, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		const failure = parsePerchFailure(await response.text());
		throw new PerchError({
			...failure,
			status: response.status,
			message: `perch: account fetch failed (${response.status}): ${failure.message}`,
		});
	}
	const body = (await response.json()) as PerchAccount;
	// The response nests the account fields under `session` (verified against
	// the CLI bundle: W4e(a.session, ...)). Missing session is treated as an
	// empty object so callers see undefined fields rather than a crash.
	if (body.session === undefined || body.session === null) {
		body.session = {};
	}
	return body;
}

/**
 * Selects the Starter ("pilot") plan when the account requires a tier.
 * Banned accounts fail login here.
 */
export async function ensureTierSelected(
	accessToken: string,
	appUrl: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const account = await fetchAccount(accessToken, appUrl, signal);
	const session = account.session ?? {};
	if (session.tierSelectionRequired !== true) {
		return;
	}
	const config = await fetchAuthConfig(appUrl, signal);
	onProgress?.("perch: selecting Starter plan…");
	const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/perch_ai_select_plan`, {
		method: "POST",
		headers: {
			apikey: config.supabaseAnonKey,
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ p_plan_code: "pilot" }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const failure = parsePerchFailure(text);
		throw new PerchError({
			...failure,
			status: response.status,
			message: `perch: Starter plan selection failed (${response.status}): ${failure.message}`,
		});
	}
	try {
		const parsed = JSON.parse(text) as { error?: string };
		if (parsed.error === "banned") {
			throw new PerchError({ message: "perch: this account is banned from Perch", terminal: true });
		}
	} catch (error) {
		if (error instanceof PerchError) {
			throw error;
		}
		// Non-JSON body: treat as success.
	}
}

/** Parses a pasted callback: full URL, path-with-query, or bare code. */
export function parseCallbackInput(input: string): { code: string | null; error: string | null } {
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		return { code: null, error: null };
	}
	try {
		const url = new URL(trimmed, "http://localhost/");
		return {
			code: url.searchParams.get("code"),
			error: url.searchParams.get("error"),
		};
	} catch {
		// Not a URL — treat as a bare code.
		return { code: trimmed, error: null };
	}
}

/**
 * Full browser login flow. `callbacks.onSelect` may offer a CLI-session
 * import before the browser path runs (handled by the caller).
 */
export async function loginPerch(appUrl: string, callbacks: OAuthLoginCallbacks): Promise<PerchCredentials> {
	const config = await fetchAuthConfig(appUrl, callbacks.signal);
	const provider = pickProvider(config.providers);
	const verifier = randomVerifier();
	const codeChallenge = challenge(verifier);

	const loopback = await startLoopbackCallback({ path: "/callback" });

	let authCode: string | null = null;
	try {
		const authorizeUrl = new URL(`${config.supabaseUrl}/auth/v1/authorize`);
		authorizeUrl.searchParams.set("provider", provider);
		authorizeUrl.searchParams.set("redirect_to", `http://127.0.0.1:${loopback.port}/callback`);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "s256");

		callbacks.onAuth({
			url: authorizeUrl.toString(),
			instructions: "Complete the Perch login in your browser. If it does not open, visit the URL above.",
		});

		const manualInput = callbacks.onManualCodeInput ? callbacks.onManualCodeInput().catch(() => null) : null;
		const code = await raceLoginInputs(
			loopback.waitForCode(callbacks.signal ?? new AbortController().signal, LOGIN_TIMEOUT_MS),
			manualInput,
		);
		if (code === null || code.trim().length === 0) {
			throw new PerchError({ message: "perch: login was cancelled or failed (no code received)" });
		}
		authCode = code.trim();
		const parsed = parseCallbackInput(authCode);
		if (parsed.error) {
			throw new PerchError({ message: `perch: login failed: ${parsed.error}` });
		}
		authCode = parsed.code ?? authCode;
	} finally {
		await loopback.close();
	}

	const tokenResponse = await exchangeCode(config, authCode, verifier, callbacks.signal);
	const access = tokenResponse.access_token;
	if (!access) {
		throw new PerchError({ message: "perch: token exchange response missing access_token" });
	}
	const credentials: PerchCredentials = {
		access,
		refresh: tokenResponse.refresh_token ?? "",
		expires: computeExpiry(tokenResponse),
		email: tokenResponse.user?.email,
		userId: tokenResponse.user?.id,
		appUrl,
	};
	await ensureTierSelected(access, appUrl, callbacks.onProgress, callbacks.signal);
	return credentials;
}

async function raceLoginInputs(
	serverWait: Promise<string | null>,
	manualInput: Promise<string | null> | null,
): Promise<string | null> {
	if (manualInput === null) {
		return serverWait;
	}
	const result = await Promise.race([serverWait, manualInput]);
	return result;
}
