import { afterEach, describe, expect, it } from "vitest";
import { redactTrackingUri, resolveAuthorizationHeader, resolveTrackingRequestHeaders } from "../src/auth.ts";

describe("resolveAuthorizationHeader / resolveTrackingRequestHeaders", () => {
	const envKeys = ["MLFLOW_TRACKING_USERNAME", "MLFLOW_TRACKING_PASSWORD", "MLFLOW_TRACKING_TOKEN"] as const;
	const previous = new Map<string, string | undefined>();

	afterEach(() => {
		for (const key of envKeys) {
			if (previous.has(key)) {
				const value = previous.get(key);
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
				previous.delete(key);
			} else if (process.env[key] !== undefined) {
				delete process.env[key];
			}
		}
	});

	function setEnv(key: (typeof envKeys)[number], value: string | undefined): void {
		if (!previous.has(key)) {
			previous.set(key, process.env[key]);
		}
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	it("uses basic auth when username and password are set", () => {
		setEnv("MLFLOW_TRACKING_USERNAME", "alice");
		setEnv("MLFLOW_TRACKING_PASSWORD", "s3cret");
		setEnv("MLFLOW_TRACKING_TOKEN", "ignored-when-basic-present");

		const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
		expect(resolveAuthorizationHeader()).toBe(expected);
		expect(resolveTrackingRequestHeaders()).toEqual({
			"Content-Type": "application/json",
			Authorization: expected,
		});
	});

	it("uses bearer token when only MLFLOW_TRACKING_TOKEN is set", () => {
		setEnv("MLFLOW_TRACKING_USERNAME", undefined);
		setEnv("MLFLOW_TRACKING_PASSWORD", undefined);
		setEnv("MLFLOW_TRACKING_TOKEN", "tok-123");

		expect(resolveAuthorizationHeader()).toBe("Bearer tok-123");
		expect(resolveTrackingRequestHeaders().Authorization).toBe("Bearer tok-123");
	});

	it("omits Authorization when no credentials are configured", () => {
		setEnv("MLFLOW_TRACKING_USERNAME", undefined);
		setEnv("MLFLOW_TRACKING_PASSWORD", undefined);
		setEnv("MLFLOW_TRACKING_TOKEN", undefined);

		expect(resolveAuthorizationHeader()).toBeUndefined();
		expect(resolveTrackingRequestHeaders()).toEqual({
			"Content-Type": "application/json",
		});
	});
});

describe("redactTrackingUri", () => {
	it("strips userinfo from https tracking URIs", () => {
		expect(redactTrackingUri("https://user:token@mlflow.example:5000")).toBe("https://mlflow.example:5000/");
	});

	it("leaves URIs without credentials unchanged", () => {
		expect(redactTrackingUri("http://localhost:5000")).toBe("http://localhost:5000");
	});

	it("returns non-URL strings unchanged", () => {
		expect(redactTrackingUri("not a url")).toBe("not a url");
	});
});
