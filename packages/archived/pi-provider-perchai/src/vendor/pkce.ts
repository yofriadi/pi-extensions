import { createHash, randomBytes } from "node:crypto";

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Cryptographically random PKCE verifier: 32 bytes, base64url-encoded. */
export function randomVerifier(): string {
	return base64url(randomBytes(32));
}

/** S256 code challenge for a verifier, base64url-encoded. */
export function challenge(verifier: string): string {
	return base64url(createHash("sha256").update(verifier, "ascii").digest());
}
