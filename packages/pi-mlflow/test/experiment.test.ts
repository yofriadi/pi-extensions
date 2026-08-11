import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOrCreateExperiment } from "../src/experiment.ts";

describe("resolveOrCreateExperiment", () => {
	const trackingUri = "http://localhost:5000";
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.MLFLOW_TRACKING_USERNAME;
		delete process.env.MLFLOW_TRACKING_PASSWORD;
		delete process.env.MLFLOW_TRACKING_TOKEN;
	});

	it("returns the existing experiment id without creating a duplicate", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ experiment: { experiment_id: "42" } }), { status: 200 }),
		);

		const id = await resolveOrCreateExperiment(trackingUri, "my-experiment");

		expect(id).toBe("42");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = fetchMock.mock.calls[0]![0] as URL;
		expect(url.toString()).toContain("/api/2.0/mlflow/experiments/get-by-name");
		expect(url.toString()).toContain("experiment_name=my-experiment");
	});

	it("creates the experiment when get-by-name reports RESOURCE_DOES_NOT_EXIST", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST", message: "no such experiment" }), {
					status: 404,
				}),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ experiment_id: "99" }), { status: 200 }));

		const id = await resolveOrCreateExperiment(trackingUri, "new-experiment");

		expect(id).toBe("99");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const createUrl = fetchMock.mock.calls[1]![0] as string;
		expect(createUrl).toContain("/api/2.0/mlflow/experiments/create");
		const createBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
		expect(createBody).toEqual({ name: "new-experiment" });
	});

	it("throws when the server is unreachable, so callers can silently disable", async () => {
		fetchMock.mockRejectedValue(new Error("fetch failed"));
		await expect(resolveOrCreateExperiment(trackingUri, "x")).rejects.toThrow("fetch failed");
	});

	it("includes structured error_code but not free-form server message or statusText", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error_code: "INTERNAL_ERROR", message: "hostile server body" }), {
				status: 500,
				// Free-form statusText is server-controlled; our errors must ignore it.
				statusText: "HACKED status text with secrets",
			}),
		);

		await expect(resolveOrCreateExperiment(trackingUri, "x")).rejects.toMatchObject({
			message: expect.stringMatching(
				/^GET experiments\/get-by-name failed: HTTP 500 \(error_code=INTERNAL_ERROR\)$/,
			),
		});

		// Free-form message and statusText must not appear in the thrown error.
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error_code: "INTERNAL_ERROR", message: "hostile server body" }), {
				status: 500,
				statusText: "HACKED status text with secrets",
			}),
		);
		try {
			await resolveOrCreateExperiment(trackingUri, "x");
			expect.unreachable("expected throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).not.toContain("hostile server body");
			expect(message).not.toContain("HACKED");
			expect(message).not.toContain("secrets");
		}
	});

	it("omits error_code when it is not a safe uppercase identifier", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error_code: "not a code\nwith control chars and free-form text", message: "x" }),
				{ status: 503, statusText: "Service Unavailable" },
			),
		);

		await expect(resolveOrCreateExperiment(trackingUri, "x")).rejects.toMatchObject({
			message: "GET experiments/get-by-name failed: HTTP 503",
		});
	});

	it("does not produce a double slash when trackingUri has a trailing slash", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ experiment: { experiment_id: "1" } }), { status: 200 }),
		);

		await resolveOrCreateExperiment("http://localhost:5000/", "my-experiment");

		const url = fetchMock.mock.calls[0]![0] as URL;
		expect(url.toString()).not.toContain("//api");
		expect(url.toString()).toContain("http://localhost:5000/api/2.0/mlflow/experiments/get-by-name");
	});

	it("re-fetches by name when create races with RESOURCE_ALREADY_EXISTS", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error_code: "RESOURCE_ALREADY_EXISTS",
						message: "Experiment 'race' already exists.",
					}),
					{ status: 400 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ experiment: { experiment_id: "77" } }), { status: 200 }),
			);

		const id = await resolveOrCreateExperiment(trackingUri, "race");

		expect(id).toBe("77");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const createUrl = fetchMock.mock.calls[1]![0] as string;
		expect(createUrl).toContain("/api/2.0/mlflow/experiments/create");
		const refetchUrl = fetchMock.mock.calls[2]![0] as URL;
		expect(refetchUrl.toString()).toContain("/api/2.0/mlflow/experiments/get-by-name");
	});

	it("re-fetches on BAD_REQUEST create when message indicates already exists", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: "Experiment name already exists" }), {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ experiment: { experiment_id: "88" } }), { status: 200 }),
			);

		const id = await resolveOrCreateExperiment(trackingUri, "dup");

		expect(id).toBe("88");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("still throws when create already-exists but re-fetch cannot resolve the id", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_ALREADY_EXISTS", message: "already exists" }), {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			);

		await expect(resolveOrCreateExperiment(trackingUri, "ghost")).rejects.toMatchObject({
			message: expect.stringMatching(
				/^POST experiments\/create failed: HTTP 400 \(error_code=RESOURCE_ALREADY_EXISTS\)$/,
			),
		});
	});

	it("does not treat unrelated create 400 as already-exists", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "INVALID_PARAMETER_VALUE", message: "name is invalid" }), {
					status: 400,
				}),
			);

		await expect(resolveOrCreateExperiment(trackingUri, "bad")).rejects.toMatchObject({
			message: expect.stringMatching(
				/^POST experiments\/create failed: HTTP 400 \(error_code=INVALID_PARAMETER_VALUE\)$/,
			),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sends basic-auth Authorization on get-by-name when MLFLOW_TRACKING_USERNAME/PASSWORD are set", async () => {
		process.env.MLFLOW_TRACKING_USERNAME = "alice";
		process.env.MLFLOW_TRACKING_PASSWORD = "s3cret";
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ experiment: { experiment_id: "42" } }), { status: 200 }),
		);

		await resolveOrCreateExperiment(trackingUri, "auth-exp");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("sends bearer Authorization on create when MLFLOW_TRACKING_TOKEN is set", async () => {
		process.env.MLFLOW_TRACKING_TOKEN = "tok-xyz";
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ experiment_id: "99" }), { status: 200 }));

		await resolveOrCreateExperiment(trackingUri, "token-exp");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			const headers = (call[1] as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer tok-xyz");
		}
	});
});
