/**
 * Shared Google OAuth helpers for the Antigravity provider.
 *
 * PKCE, local callback server, userinfo lookup, token exchange, project
 * discovery integration, expiry calculation. The provider-specific configuration
 * lives in `google-antigravity-oauth.ts`; this file holds the cross-cutting bits
 * and the shared `loginWithGoogleOAuth` driver.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { oauthErrorHtml, oauthSuccessHtml } from "./vendor/oauth-page.ts";
import { generatePKCE } from "./vendor/pkce.ts";

/** Optional bind host; when unset, listen on both loopback families if available. */
export const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST;

let _createServer: typeof import("node:http").createServer | null = null;
let _httpImportPromise: Promise<void> | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	_httpImportPromise = import("node:http").then((m) => {
		_createServer = m.createServer;
	});
}

/** Lazily resolve Node's http.createServer, throwing in non-Node runtimes. */
export async function getNodeCreateServer(): Promise<typeof import("node:http").createServer> {
	if (_createServer) return _createServer;
	if (_httpImportPromise) {
		await _httpImportPromise;
	}
	if (_createServer) return _createServer;
	throw new Error("Google OAuth is only available in Node.js environments");
}

/**
 * Result delivered to a callback waiter.
 *
 * - `ok`: browser redirected with `?code=…&state=…` and the values are present.
 * - `error`: Google redirected with `?error=…` (user denied, access blocked, etc.).
 *
 * A `null` waiter result means `cancelWait()` was called, typically because a
 * manual paste input arrived first.
 */
export type CallbackWaitResult = { kind: "ok"; code: string; state: string } | { kind: "error"; error: string };

export type CallbackServerInfo = {
	server: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<CallbackWaitResult | null>;
};

/**
 * Start a local HTTP server that listens for an OAuth callback on the given
 * port and path. `localOrigin` is used to parse the request URL into a real
 * `URL` (no Host header in HTTP/1.0 requests, so we provide it explicitly).
 *
 * The waiter settles on either a successful `?code=…` callback, a
 * `?error=…` denial (so the login can surface it instead of hanging), or a
 * manual `cancelWait()`.
 */
function matchesCallbackPath(pathname: string, callbackPath: string): boolean {
	return pathname === callbackPath || pathname === `${callbackPath}/`;
}
export async function startCallbackServer(
	port: number,
	callbackPath: string,
	localOrigin: string,
): Promise<CallbackServerInfo> {
	const createServer = await getNodeCreateServer();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: CallbackWaitResult | null) => void) | undefined;
		const waitForCodePromise = new Promise<CallbackWaitResult | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", localOrigin);

			if (matchesCallbackPath(url.pathname, callbackPath)) {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Google authentication did not complete.", `Error: ${error}`));
					settleWait?.({ kind: "error", error });
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
					settleWait?.({ kind: "ok", code, state });
				} else {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
				}
			} else {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(port, CALLBACK_HOST, () => {
			resolve({
				server,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

/**
 * Parse a redirect URL (full URL, callback path, or bare `?code=…&state=…`
 * query string) and return the `code` and `state` params. Returns undefineds
 * on failure to parse or when the params are absent.
 *
 * `new URL(value, "http://localhost/")` handles all three documented inputs:
 * full URLs are absolute and take precedence over the base, while bare
 * query strings and callback paths are resolved against the placeholder
 * base. Without the base, `new URL("?code=…")` throws and the manual
 * fallback silently broke.
 */
export function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	let url: URL;
	try {
		url = new URL(value, "http://localhost/");
	} catch {
		return {};
	}
	return {
		code: url.searchParams.get("code") ?? undefined,
		state: url.searchParams.get("state") ?? undefined,
	};
}

/**
 * Resolve the user email from a Google access token via the userinfo endpoint.
 * Returns undefined on any failure — the email is purely informational and
 * login proceeds even if lookup fails.
 */
export async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		return await withAbortTimeout(async (signal) => {
			const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
				signal,
			});

			if (!response.ok) return undefined;

			const data = (await response.json()) as { email?: string };
			return data.email;
		}, USERINFO_TIMEOUT_MS);
	} catch {
		// Ignore errors, email is optional
	}
	return undefined;
}

// ============================================================================
// Shared login flow
// ============================================================================

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const USERINFO_TIMEOUT_MS = 10_000;

export async function withAbortTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await task(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

export interface GoogleOAuthLoginConfig {
	/** Display name used in error messages. */
	name: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	callbackPort: number;
	callbackPath: string;
	callbackOrigin: string;
	scopes: string[];
	/**
	 * Provider-specific: discover the user's Google Cloud project ID from the
	 * access token. May onboard or provision a new project for the user.
	 */
	discoverProject: (accessToken: string, onProgress?: (msg: string) => void) => Promise<string>;
}

export interface LoginWithGoogleOAuthOptions {
	/**
	 * Pre-started callback server. If provided, the login function uses it
	 * instead of starting its own. The caller remains responsible for closing
	 * the server. Intended for tests that need to know the bound port.
	 */
	server?: CallbackServerInfo;
}

/**
 * Run the shared Google OAuth login flow.
 *
 *  1. Generate PKCE verifier/challenge
 *  2. Start local callback server (or use the provided one)
 *  3. Emit auth URL
 *  4. Race browser callback against optional manual paste input
 *  5. Validate state, exchange code for tokens
 *  6. Fetch email, discover project, build credentials
 *
 * The caller supplies provider-specific config (client, scopes, project
 * discovery) so the same flow powers the provider.
 */
export async function loginWithGoogleOAuth(
	config: GoogleOAuthLoginConfig,
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
	options?: LoginWithGoogleOAuthOptions,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const ownsServer = !options?.server;
	const server =
		options?.server ??
		(await (async () => {
			onProgress?.("Starting local server for OAuth callback...");
			return startCallbackServer(config.callbackPort, config.callbackPath, config.callbackOrigin);
		})());

	let manualInput: string | undefined;
	let manualError: Error | undefined;
	let manualPromise: Promise<void> | undefined;
	if (onManualCodeInput) {
		manualPromise = onManualCodeInput()
			.then((input) => {
				manualInput = input;
				server.cancelWait();
			})
			.catch((err) => {
				manualError = err instanceof Error ? err : new Error(String(err));
				server.cancelWait();
			});
	}

	try {
		const authParams = new URLSearchParams({
			client_id: config.clientId,
			response_type: "code",
			redirect_uri: config.redirectUri,
			scope: config.scopes.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;

		onAuth({ url: authUrl, instructions: "Complete the sign-in in your browser." });
		onProgress?.("Waiting for OAuth callback...");

		const code = await waitForAuthCode(server, verifier, onManualCodeInput !== undefined, () => ({
			manualInput,
			manualError,
			manualPromise,
		}));

		// Exchange code for tokens
		onProgress?.("Exchanging authorization code for tokens...");
		const tokenResponse = await withAbortTimeout(
			(signal) =>
				fetch(GOOGLE_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: config.clientId,
						client_secret: config.clientSecret,
						code,
						grant_type: "authorization_code",
						redirect_uri: config.redirectUri,
						code_verifier: verifier,
					}),
					signal,
				}),
			10_000,
		);

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new Error(`Token exchange failed: ${error}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new Error("No refresh token received. Please try again.");
		}

		onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);

		const projectId = await config.discoverProject(tokenData.access_token, onProgress);

		const expiresAt = Date.now() + tokenData.expires_in * 1000 - EXPIRY_BUFFER_MS;

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};
	} finally {
		// Only close the server if we started it. The manual input promise is
		// intentionally not drained here: on the manual-wins path,
		// `waitForAuthCode` already awaits it before we reach this `finally`;
		// on the browser-wins path the manual promise stays pending and that
		// is the correct behaviour (the user may still type into the manual
		// prompt after the callback has already resolved). Awaiting it
		// unconditionally used to hang cleanup forever in that case.
		if (ownsServer) {
			server.server.close();
		}
	}
}

/**
 * Resolve the authorization code from either the browser callback or the
 * manual paste input. Encapsulates the race + state validation + error
 * surfacing.
 */
async function waitForAuthCode(
	server: CallbackServerInfo,
	verifier: string,
	hasManual: boolean,
	getManual: () => {
		manualInput: string | undefined;
		manualError: Error | undefined;
		manualPromise: Promise<void> | undefined;
	},
): Promise<string> {
	const callbackResult = await server.waitForCode();

	if (callbackResult !== null) {
		// Browser callback resolved first (success or denial).
		if (callbackResult.kind === "error") {
			throw new Error(`Google authentication failed: ${callbackResult.error}`);
		}
		if (callbackResult.state !== verifier) {
			throw new Error("OAuth state mismatch - possible CSRF attack");
		}
		return callbackResult.code;
	}

	// Waiter was cancelled — manual input was meant to win. The manual
	// promise's then/catch calls cancelWait(), which settles the waiter
	// with null, so by the time we get here the manual state is set.
	const { manualError, manualInput, manualPromise } = getManual();
	if (manualError) {
		throw manualError;
	}
	if (!hasManual || !manualInput) {
		throw new Error("No authorization code received");
	}
	// Drain the manual promise so it doesn't leak.
	if (manualPromise) {
		await manualPromise.catch(() => {});
	}
	const parsed = parseRedirectUrl(manualInput);
	if (parsed.state && parsed.state !== verifier) {
		throw new Error("OAuth state mismatch - possible CSRF attack");
	}
	if (!parsed.code) {
		throw new Error("No authorization code received");
	}
	return parsed.code;
}
