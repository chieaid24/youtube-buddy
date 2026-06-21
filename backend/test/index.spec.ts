import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A full, valid Progress Record body. Tests override fields as needed.
function body(overrides: Record<string, unknown> = {}) {
	return {
		clientId: "a1b2c3d4",
		name: "aidan",
		videoId: "abc123",
		timestamp: 412,
		duration: 1300,
		...overrides,
	};
}

function post(code: string, payload: unknown) {
	return SELF.fetch(`https://example.com/?code=${code}`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

describe("POST /?code=", () => {
	it("stores a Progress Record and returns ok", async () => {
		const code = "post-stores";
		const res = await post(code, body());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const raw = await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw!);
		expect(record).toMatchObject({
			clientId: "a1b2c3d4",
			name: "aidan",
			videoId: "abc123",
			timestamp: 412,
			duration: 1300,
		});
	});

	it("sets updatedAt server-side, ignoring the client's value", async () => {
		const code = "post-updatedat";
		const before = Date.now();
		// Client attempts to forge updatedAt; the server must overwrite it.
		await post(code, body({ updatedAt: 1 }));
		const after = Date.now();

		const record = JSON.parse(
			(await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!
		);
		expect(record.updatedAt).toBeGreaterThanOrEqual(before);
		expect(record.updatedAt).toBeLessThanOrEqual(after);
	});

	it("keys per video, so one client can have many records under a code", async () => {
		const code = "post-multivideo";
		await post(code, body({ videoId: "vid-one" }));
		await post(code, body({ videoId: "vid-two" }));

		expect(await env.PROGRESS.get(`${code}:a1b2c3d4:vid-one`)).not.toBeNull();
		expect(await env.PROGRESS.get(`${code}:a1b2c3d4:vid-two`)).not.toBeNull();
	});

	it("rejects a body missing a required field with 400", async () => {
		const code = "post-missing-field";
		const { duration, ...withoutDuration } = body();
		const res = await post(code, withoutDuration);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/duration/);
	});

	it("accepts an empty name, storing it as \"\" (Display Name is optional)", async () => {
		const code = "post-empty-name";
		const res = await post(code, body({ name: "" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const record = JSON.parse(
			(await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!
		);
		expect(record.name).toBe("");
	});

	it("accepts a missing name, coercing it to \"\" on store", async () => {
		const code = "post-missing-name";
		const { name, ...withoutName } = body();
		const res = await post(code, withoutName);
		expect(res.status).toBe(200);

		const record = JSON.parse(
			(await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!
		);
		expect(record.name).toBe("");
	});

	it("rejects a body with a non-numeric timestamp with 400", async () => {
		const code = "post-bad-timestamp";
		const res = await post(code, body({ timestamp: "nope" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/timestamp/);
	});

	it("rejects a missing code with 400", async () => {
		const res = await SELF.fetch("https://example.com/", {
			method: "POST",
			body: JSON.stringify(body()),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "missing code" });
	});
});

describe("Group cap (POST)", () => {
	const members = ["m1", "m2", "m3", "m4", "m5"];

	it("admits up to 5 distinct Client IDs under one code", async () => {
		const code = "cap-five";
		for (const clientId of members) {
			const res = await post(code, body({ clientId, videoId: "v" }));
			expect(res.status).toBe(200);
		}
	});

	it("rejects a 6th distinct Client ID with 409 group full", async () => {
		const code = "cap-sixth";
		for (const clientId of members) {
			await post(code, body({ clientId, videoId: "v" }));
		}
		const res = await post(code, body({ clientId: "m6", videoId: "v" }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "group full" });
		// The rejected member left no record behind.
		expect(await env.PROGRESS.get(`${code}:m6:v`)).toBeNull();
	});

	it("still accepts a returning member's new video when the group is full", async () => {
		const code = "cap-returning";
		for (const clientId of members) {
			await post(code, body({ clientId, videoId: "v1" }));
		}
		// m1 is already a member; a new video must go through even at capacity.
		const res = await post(code, body({ clientId: "m1", videoId: "v2" }));
		expect(res.status).toBe(200);
		expect(await env.PROGRESS.get(`${code}:m1:v2`)).not.toBeNull();
	});
});

describe("GET /?code=", () => {
	it("returns a flat array of all live records for the code, and nothing from other codes", async () => {
		const codeA = "get-code-a";
		const codeB = "get-code-b";
		await post(codeA, body({ clientId: "c1", videoId: "v1" }));
		await post(codeA, body({ clientId: "c2", videoId: "v2" }));
		await post(codeB, body({ clientId: "c3", videoId: "v3" }));

		const res = await SELF.fetch(`https://example.com/?code=${codeA}`);
		expect(res.status).toBe(200);
		const records = await res.json();
		expect(Array.isArray(records)).toBe(true);
		expect(records).toHaveLength(2);

		const clientIds = records.map((r: { clientId: string }) => r.clientId).sort();
		expect(clientIds).toEqual(["c1", "c2"]);
	});

	it("rejects a missing code with 400", async () => {
		const res = await SELF.fetch("https://example.com/");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "missing code" });
	});
});

describe("cross-cutting", () => {
	it("includes wide-open CORS headers on a normal response", async () => {
		const res = await SELF.fetch("https://example.com/?code=cors-get");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("answers an OPTIONS preflight with CORS headers", async () => {
		const request = new IncomingRequest("https://example.com/?code=cors-preflight", {
			method: "OPTIONS",
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
	});

	it("rejects an unsupported method with 405", async () => {
		const res = await SELF.fetch("https://example.com/?code=method-not-allowed", {
			method: "DELETE",
		});
		expect(res.status).toBe(405);
		expect(await res.json()).toEqual({ error: "method not allowed" });
	});
});
