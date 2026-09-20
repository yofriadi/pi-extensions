import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const FALLBACK_PORTS = [47321, 47322, 47323, 47324, 47325];

export interface LoopbackCallback {
	/** The port the callback server is listening on. */
	port: number;
	/**
	 * Resolves with the captured `?code=` once it arrives, or null when the
	 * wait is cancelled or the callback carries `?error=`. Rejects on timeout.
	 */
	waitForCode(signal: AbortSignal, timeoutMs: number): Promise<string | null>;
	/** Stops the server and resolves any pending wait with null. */
	close(): Promise<void>;
}

export interface LoopbackOptions {
	/** URL path the server matches (default "/callback"). */
	path?: string;
}

interface WaitState {
	resolve: (code: string | null) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

function matchesCallbackPath(requestPath: string, callbackPath: string): boolean {
	return requestPath === callbackPath || requestPath === `${callbackPath}/`;
}

function htmlPage(title: string, bodyClass: string): string {
	return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body class="${bodyClass}">
<h1>${title}</h1>
</body>
</html>`;
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		// Dropping kept-alive sockets lets close() finish promptly.
		server.closeAllConnections?.();
	});
}

/**
 * Binds a loopback HTTP server on 127.0.0.1 (ephemeral port, with a small
 * static fallback list) that captures the OAuth `?code=` redirect.
 */
export async function startLoopbackCallback(options: LoopbackOptions = {}): Promise<LoopbackCallback> {
	const callbackPath = options.path ?? "/callback";
	let wait: WaitState | null = null;

	const { server, port } = await startServer(callbackPath);

	function settleWait(value: string | null): void {
		if (!wait) {
			return;
		}
		const current = wait;
		wait = null;
		if (current.timer) {
			clearTimeout(current.timer);
		}
		current.resolve(value);
	}

	server.on("request", (req: IncomingMessage, res: ServerResponse) => {
		function finish(status: number, title: string, bodyClass: string): void {
			res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
			res.end(htmlPage(title, bodyClass));
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!matchesCallbackPath(url.pathname, callbackPath)) {
			finish(404, "Not found", "not-found");
			return;
		}
		const code = url.searchParams.get("code");
		const error = url.searchParams.get("error");
		if (code) {
			finish(200, "Login complete — return to pi", "success");
			settleWait(code);
			return;
		}
		if (error) {
			// Never reflect the attacker-controlled query value into HTML.
			finish(400, "Login failed — return to pi", "error");
			settleWait(null);
			return;
		}
		finish(400, "Missing code", "error");
	});

	async function startServer(path: string): Promise<{ server: Server; port: number }> {
		for (const port of [0, ...FALLBACK_PORTS]) {
			const server = createServer();
			try {
				await listen(server, port);
			} catch {
				continue;
			}
			const actual = (server.address() as AddressInfo).port;
			return { server, port: actual };
		}
		throw new Error(`perch: unable to bind a loopback callback server on 127.0.0.1 (path ${path})`);
	}

	return {
		port,
		waitForCode(signal, timeoutMs) {
			return new Promise<string | null>((resolve, reject) => {
				if (wait) {
					reject(new Error("perch: a code wait is already pending"));
					return;
				}
				wait = {
					resolve,
					reject,
					timer: setTimeout(() => {
						wait = null;
						reject(new Error("perch: timed out waiting for the login redirect"));
					}, timeoutMs),
				};
				const onAbort = () => settleWait(null);
				signal.addEventListener("abort", onAbort, { once: true });
				// Clean the listener up when the wait settles either way.
				const originalResolve = wait.resolve;
				wait.resolve = (value) => {
					signal.removeEventListener("abort", onAbort);
					originalResolve(value);
				};
			});
		},
		async close() {
			settleWait(null);
			await closeServer(server);
		},
	};
}
