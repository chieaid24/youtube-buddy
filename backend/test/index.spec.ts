import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A full, valid Progress Record body. Tests override fields as needed.
function body(overrides: Record<string, unknown> = {}) {
	return {
		clientId: 'a1b2c3d4',
		name: 'aidan',
		videoId: 'abc123',
		timestamp: 412,
		duration: 1300,
		...overrides,
	};
}

function post(code: string, payload: unknown) {
	return SELF.fetch(`https://example.com/?code=${code}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	});
}

function postPresence(code: string, payload: unknown) {
	return SELF.fetch(`https://example.com/presence?code=${code}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	});
}

function noteBody(overrides: Record<string, unknown> = {}) {
	return {
		clientId: 'a1b2c3d4',
		name: 'aidan',
		videoId: 'abc123',
		timestamp: 42,
		kind: 'text',
		body: 'great moment',
		...overrides,
	};
}

function postNote(code: string, payload: unknown) {
	return SELF.fetch(`https://example.com/notes?code=${code}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	});
}

function deleteNote(code: string, clientId: string, id: string) {
	return SELF.fetch(`https://example.com/notes?code=${code}&clientId=${clientId}&id=${id}`, { method: 'DELETE' });
}

function deleteMember(code: string, clientId?: string) {
	const qs = clientId === undefined ? `code=${code}` : `code=${code}&clientId=${clientId}`;
	return SELF.fetch(`https://example.com/member?${qs}`, { method: 'DELETE' });
}

function replyBody(noteId: string, overrides: Record<string, unknown> = {}) {
	return { clientId: 'a1b2c3d4', name: 'aidan', noteId, body: 'nice one', ...overrides };
}

function postReply(code: string, payload: unknown) {
	return SELF.fetch(`https://example.com/replies?code=${code}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	});
}

function getConversation(code: string, noteId: string) {
	return SELF.fetch(`https://example.com/conversation?code=${code}&noteId=${noteId}`);
}

// Create a Note through the API and return its complete server record.
async function createNote(code: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; clientId: string }> {
	const res = await postNote(code, noteBody(overrides));
	expect(res.status).toBe(200);
	return ((await res.json()) as { note: { id: string; clientId: string } }).note;
}

describe('POST /?code=', () => {
	it('stores a Progress Record and returns ok', async () => {
		const code = 'post-stores';
		const res = await post(code, body());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const raw = await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw!);
		expect(record).toMatchObject({
			clientId: 'a1b2c3d4',
			name: 'aidan',
			videoId: 'abc123',
			timestamp: 412,
			duration: 1300,
		});
	});

	it("sets updatedAt server-side, ignoring the client's value", async () => {
		const code = 'post-updatedat';
		const before = Date.now();
		// Client attempts to forge updatedAt; the server must overwrite it.
		await post(code, body({ updatedAt: 1 }));
		const after = Date.now();

		const record = JSON.parse((await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!);
		expect(record.updatedAt).toBeGreaterThanOrEqual(before);
		expect(record.updatedAt).toBeLessThanOrEqual(after);
	});

	it('keys per video, so one client can have many records under a code', async () => {
		const code = 'post-multivideo';
		await post(code, body({ videoId: 'vid-one' }));
		await post(code, body({ videoId: 'vid-two' }));

		expect(await env.PROGRESS.get(`${code}:a1b2c3d4:vid-one`)).not.toBeNull();
		expect(await env.PROGRESS.get(`${code}:a1b2c3d4:vid-two`)).not.toBeNull();
	});

	it('rejects a body missing a required field with 400', async () => {
		const code = 'post-missing-field';
		const { duration, ...withoutDuration } = body();
		const res = await post(code, withoutDuration);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/duration/);
	});

	it('accepts an empty name, storing it as "" (Display Name is optional)', async () => {
		const code = 'post-empty-name';
		const res = await post(code, body({ name: '' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const record = JSON.parse((await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!);
		expect(record.name).toBe('');
	});

	it('accepts a missing name, coercing it to "" on store', async () => {
		const code = 'post-missing-name';
		const { name, ...withoutName } = body();
		const res = await post(code, withoutName);
		expect(res.status).toBe(200);

		const record = JSON.parse((await env.PROGRESS.get(`${code}:a1b2c3d4:abc123`))!);
		expect(record.name).toBe('');
	});

	it('rejects a body with a non-numeric timestamp with 400', async () => {
		const code = 'post-bad-timestamp';
		const res = await post(code, body({ timestamp: 'nope' }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/timestamp/);
	});

	it('rejects a missing code with 400', async () => {
		const res = await SELF.fetch('https://example.com/', {
			method: 'POST',
			body: JSON.stringify(body()),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'missing code', category: 'validation' });
	});
});

describe('Room cap (POST)', () => {
	const members = ['m1', 'm2', 'm3', 'm4', 'm5'];

	it('admits up to 5 distinct Client IDs under one code', async () => {
		const code = 'cap-five';
		for (const clientId of members) {
			const res = await post(code, body({ clientId, videoId: 'v' }));
			expect(res.status).toBe(200);
		}
	});

	it('rejects a 6th distinct Client ID with 409 room full', async () => {
		const code = 'cap-sixth';
		for (const clientId of members) {
			await post(code, body({ clientId, videoId: 'v' }));
		}
		const res = await post(code, body({ clientId: 'm6', videoId: 'v' }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'room full', category: 'room_full' });
		// The rejected member left no record behind.
		expect(await env.PROGRESS.get(`${code}:m6:v`)).toBeNull();
	});

	it("still accepts a returning member's new video when the room is full", async () => {
		const code = 'cap-returning';
		for (const clientId of members) {
			await post(code, body({ clientId, videoId: 'v1' }));
		}
		// m1 is already a member; a new video must go through even at capacity.
		const res = await post(code, body({ clientId: 'm1', videoId: 'v2' }));
		expect(res.status).toBe(200);
		expect(await env.PROGRESS.get(`${code}:m1:v2`)).not.toBeNull();
	});
});

describe('POST /presence?code=', () => {
	it('stores a Presence Record with a server-set updatedAt', async () => {
		const code = 'presence-stores';
		const before = Date.now();
		const res = await postPresence(code, { clientId: 'p1', name: 'aidan' });
		const after = Date.now();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const raw = await env.PROGRESS.get(`${code}:presence:p1`);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw!);
		expect(record).toMatchObject({ clientId: 'p1', name: 'aidan' });
		expect(record.updatedAt).toBeGreaterThanOrEqual(before);
		expect(record.updatedAt).toBeLessThanOrEqual(after);
	});

	it('coerces a missing name to "" (Display Name is optional)', async () => {
		const code = 'presence-missing-name';
		const res = await postPresence(code, { clientId: 'p1' });
		expect(res.status).toBe(200);

		const record = JSON.parse((await env.PROGRESS.get(`${code}:presence:p1`))!);
		expect(record.name).toBe('');
	});

	it('stores an empty name as ""', async () => {
		const code = 'presence-empty-name';
		await postPresence(code, { clientId: 'p1', name: '' });

		const record = JSON.parse((await env.PROGRESS.get(`${code}:presence:p1`))!);
		expect(record.name).toBe('');
	});

	it('rejects a missing clientId with 400', async () => {
		const code = 'presence-no-client';
		const res = await postPresence(code, { name: 'nobody' });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'missing or invalid field: clientId',
			category: 'validation',
		});
	});

	it('rejects an empty clientId with 400', async () => {
		const code = 'presence-empty-client';
		const res = await postPresence(code, { clientId: '', name: 'nobody' });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/clientId/);
	});
});

describe('DELETE /member?code=', () => {
	it('deletes presence and every Progress Record for the member', async () => {
		const code = 'member-delete';
		await postPresence(code, { clientId: 'p1', name: 'x' });
		await post(code, body({ clientId: 'p1', videoId: 'v1' }));
		await post(code, body({ clientId: 'p1', videoId: 'v2' }));
		expect(await env.PROGRESS.get(`${code}:presence:p1`)).not.toBeNull();

		const res = await deleteMember(code, 'p1');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(await env.PROGRESS.get(`${code}:presence:p1`)).toBeNull();
		expect(await env.PROGRESS.get(`${code}:p1:v1`)).toBeNull();
		expect(await env.PROGRESS.get(`${code}:p1:v2`)).toBeNull();
	});

	it('is idempotent: deleting an absent member still returns ok', async () => {
		const code = 'member-delete-absent';
		const res = await deleteMember(code, 'ghost');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('rejects a missing clientId query with 400', async () => {
		const code = 'member-delete-no-client';
		const res = await deleteMember(code);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'missing clientId', category: 'validation' });
	});

	it('does not retain the removed member across paginated listings', async () => {
		const code = 'member-delete-paginated';
		await postPresence(code, { clientId: 'p1' });
		await Promise.all(
			Array.from({ length: 501 }, (_, i) =>
				env.PROGRESS.put(`${code}:p1:video-${String(i).padStart(4, '0')}`, JSON.stringify(body({ clientId: 'p1', videoId: `video-${i}` }))),
			),
		);

		const res = await deleteMember(code, 'p1');
		expect(res.status).toBe(200);
		const remaining = await env.PROGRESS.list({ prefix: `${code}:p1:` });
		expect(remaining.keys).toHaveLength(0);
		expect(await env.PROGRESS.get(`${code}:presence:p1`)).toBeNull();
	}, 30_000);

	it('preserves other members and other Rooms', async () => {
		const code = 'member-delete-scoped';
		await post(code, body({ clientId: 'p1', videoId: 'mine' }));
		await post(code, body({ clientId: 'p2', videoId: 'theirs' }));
		await post('other-room', body({ clientId: 'p1', videoId: 'elsewhere' }));

		await deleteMember(code, 'p1');
		expect(await env.PROGRESS.get(`${code}:p2:theirs`)).not.toBeNull();
		expect(await env.PROGRESS.get('other-room:p1:elsewhere')).not.toBeNull();
	});

	it('immediately frees a full Room slot', async () => {
		const code = 'member-delete-frees-slot';
		for (const clientId of ['m1', 'm2', 'm3', 'm4', 'm5']) {
			await postPresence(code, { clientId });
		}
		expect((await postPresence(code, { clientId: 'm6' })).status).toBe(409);

		await deleteMember(code, 'm3');
		expect((await postPresence(code, { clientId: 'm6' })).status).toBe(200);
	});

	it('does not keep the old /presence deletion alias', async () => {
		const res = await SELF.fetch('https://example.com/presence?code=no-alias&clientId=p1', {
			method: 'DELETE',
		});
		expect(res.status).toBe(405);
	});
});

describe('POST /notes?code=', () => {
	it('stores a Note with server fields and returns the complete record', async () => {
		const code = 'note-stores';
		const before = Date.now();
		const res = await postNote(code, noteBody({ spoiler: true, createdAt: 1, id: 'forged' }));
		const after = Date.now();
		expect(res.status).toBe(200);
		const result = (await res.json()) as { ok: boolean; id: string; note: Record<string, unknown> };
		expect(result.ok).toBe(true);
		expect(result.id).not.toBe('forged');

		const raw = await env.PROGRESS.get(`${code}:note:a1b2c3d4:abc123:${result.id}`);
		const note = JSON.parse(raw!);
		expect(note).toMatchObject({ id: result.id, clientId: 'a1b2c3d4', body: 'great moment', spoiler: true });
		expect(note.createdAt).toBeGreaterThanOrEqual(before);
		expect(note.createdAt).toBeLessThanOrEqual(after);
		// The response carries the complete server-authoritative record — the
		// extension renders it on the Video Timeline without a refresh.
		expect(result.note).toEqual(note);
	});

	it('accepts a text body of exactly 100 characters and rejects 101', async () => {
		const code = 'note-boundary';
		expect((await postNote(code, noteBody({ body: 'x'.repeat(100) }))).status).toBe(200);
		const res = await postNote(code, noteBody({ body: 'x'.repeat(101) }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'text body exceeds 100 characters', category: 'validation' });
	});

	it('rejects a Spoiler Reaction instead of persisting the contradiction', async () => {
		const res = await postNote('note-spoiler-emoji', noteBody({ kind: 'emoji', body: '\u{1F44D}', spoiler: true }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'a reaction cannot be a spoiler', category: 'validation' });
	});

	it.each([
		['missing clientId', noteBody({ clientId: undefined })],
		['missing videoId', noteBody({ videoId: undefined })],
		['missing timestamp', noteBody({ timestamp: undefined })],
		['missing body', noteBody({ body: '' })],
		['invalid kind', noteBody({ kind: 'gif' })],
		['oversized text', noteBody({ body: 'x'.repeat(101) })],
		['non-curated emoji', noteBody({ kind: 'emoji', body: '\u{1F4A9}' })],
	])('rejects %s', async (_name, payload) => {
		const res = await postNote('note-invalid', payload);
		expect(res.status).toBe(400);
	});

	it('accepts a curated emoji and defaults optional fields', async () => {
		const code = 'note-emoji';
		const { name, ...payload } = noteBody({ kind: 'emoji', body: '\u{1F44D}' });
		const res = await postNote(code, payload);
		const { id } = (await res.json()) as { id: string };
		const note = JSON.parse((await env.PROGRESS.get(`${code}:note:a1b2c3d4:abc123:${id}`))!);
		expect(note).toMatchObject({ name: '', spoiler: false, kind: 'emoji', body: '\u{1F44D}' });
	});

	it('rejects a new member when the Room is full', async () => {
		const code = 'note-room-full';
		for (const clientId of ['m1', 'm2', 'm3', 'm4', 'm5']) await postPresence(code, { clientId });
		const res = await postNote(code, noteBody({ clientId: 'm6' }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'room full', category: 'room_full' });
	});
});

describe('DELETE /notes?code=', () => {
	it('deletes an owned Note', async () => {
		const code = 'note-delete';
		const created = (await (await postNote(code, noteBody())).json()) as { id: string };
		const res = await deleteNote(code, 'a1b2c3d4', created.id);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(await env.PROGRESS.list({ prefix: `${code}:note:` })).toMatchObject({ keys: [] });
	});

	it("forbids deleting another member's Note", async () => {
		const code = 'note-delete-forbidden';
		const created = (await (await postNote(code, noteBody())).json()) as { id: string };
		const res = await deleteNote(code, 'someone-else', created.id);
		expect(res.status).toBe(403);
		expect((await env.PROGRESS.list({ prefix: `${code}:note:` })).keys).toHaveLength(1);
	});

	it('is idempotent for an unknown Note id', async () => {
		const res = await deleteNote('note-delete-absent', 'a1b2c3d4', 'unknown');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe('Room cap counts presence rows', () => {
	const members = ['m1', 'm2', 'm3', 'm4', 'm5'];

	it('rejects a 6th distinct presence member with 409 room full', async () => {
		const code = 'cap-presence-six';
		for (const clientId of members) {
			const res = await postPresence(code, { clientId });
			expect(res.status).toBe(200);
		}
		const res = await postPresence(code, { clientId: 'm6' });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'room full', category: 'room_full' });
		expect(await env.PROGRESS.get(`${code}:presence:m6`)).toBeNull();
	});

	it('rejects a 6th progress member when 5 presence members fill the cap', async () => {
		const code = 'cap-presence-then-progress';
		for (const clientId of members) {
			await postPresence(code, { clientId });
		}
		const res = await post(code, body({ clientId: 'm6', videoId: 'v' }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'room full', category: 'room_full' });
		expect(await env.PROGRESS.get(`${code}:m6:v`)).toBeNull();
	});

	it('admits a returning presence member at capacity', async () => {
		const code = 'cap-presence-returning';
		for (const clientId of members) {
			await postPresence(code, { clientId });
		}
		const res = await postPresence(code, { clientId: 'm1', name: 'updated' });
		expect(res.status).toBe(200);
	});
});

describe('GET /?code=', () => {
	it('returns { progress, presence, notes } for the code, and nothing from other codes', async () => {
		const codeA = 'get-code-a';
		const codeB = 'get-code-b';
		await post(codeA, body({ clientId: 'c1', videoId: 'v1' }));
		await post(codeA, body({ clientId: 'c2', videoId: 'v2' }));
		await post(codeB, body({ clientId: 'c3', videoId: 'v3' }));

		const res = await SELF.fetch(`https://example.com/?code=${codeA}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			progress: { clientId: string }[];
			presence: { clientId: string }[];
			notes: unknown[];
		};
		// No presence rows were written for this code.
		expect(data.presence).toEqual([]);
		expect(data.progress).toHaveLength(2);
		expect(data.notes).toEqual([]);

		const clientIds = data.progress.map((r) => r.clientId).sort();
		expect(clientIds).toEqual(['c1', 'c2']);
	});

	// Regression guard for #50 (silent Buddy blackout). The renderer reads
	// `{ progress, presence, notes }` from this response; if the GET ever drops a
	// field or answers non-2xx, `getRecords` swallows it into empty arrays and BOTH
	// surfaces (timeline markers + thumbnail bars) go blank with no error. Pin the
	// exact shape/status for the two Rooms most likely to expose an omission: one
	// with progress but no Notes, and a wholly empty Room.
	it('always answers 200 with progress/presence/notes as arrays (progress-but-no-notes Room)', async () => {
		const code = 'get-shape-progress-only';
		await post(code, body({ clientId: 'p1', videoId: 'v1' }));

		const res = await SELF.fetch(`https://example.com/?code=${code}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { progress: unknown[]; presence: unknown[]; notes: unknown[] };
		expect(Array.isArray(data.progress)).toBe(true);
		expect(Array.isArray(data.presence)).toBe(true);
		expect(Array.isArray(data.notes)).toBe(true);
		expect(data.progress).toHaveLength(1);
		expect(data.presence).toEqual([]);
		expect(data.notes).toEqual([]);
	});

	it('always answers 200 with empty progress/presence/notes/replies arrays for a Room with no records', async () => {
		const res = await SELF.fetch('https://example.com/?code=get-shape-empty-room');
		expect(res.status).toBe(200);
		const data = (await res.json()) as { progress: unknown[]; presence: unknown[]; notes: unknown[]; replies: unknown[] };
		expect(data).toEqual({ progress: [], presence: [], notes: [], replies: [] });
	});

	it('includes Notes without mixing them into progress', async () => {
		const code = 'get-notes';
		await post(code, body());
		await postNote(code, noteBody({ body: 'hello' }));
		const data = (await (await SELF.fetch(`https://example.com/?code=${code}`)).json()) as {
			progress: unknown[];
			notes: { body: string }[];
		};
		expect(data.progress).toHaveLength(1);
		expect(data.notes.map((note) => note.body)).toEqual(['hello']);
	});

	it('returns both progress and presence rows for a code that has each', async () => {
		const code = 'get-both';
		await post(code, body({ clientId: 'c1', videoId: 'v1' }));
		await postPresence(code, { clientId: 'c2', name: 'buddy' });

		const res = await SELF.fetch(`https://example.com/?code=${code}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			progress: { clientId: string }[];
			presence: { clientId: string }[];
		};
		expect(data.progress.map((r) => r.clientId)).toEqual(['c1']);
		expect(data.presence.map((r) => r.clientId)).toEqual(['c2']);
	});

	it('rejects a missing code with 400', async () => {
		const res = await SELF.fetch('https://example.com/');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'missing code', category: 'validation' });
	});
});

describe('cross-cutting', () => {
	it('includes wide-open CORS headers on a normal response', async () => {
		const res = await SELF.fetch('https://example.com/?code=cors-get');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('answers an OPTIONS preflight with CORS headers', async () => {
		const request = new IncomingRequest('https://example.com/?code=cors-preflight', {
			method: 'OPTIONS',
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
	});

	it('rejects an unsupported method/path with 405', async () => {
		const res = await SELF.fetch('https://example.com/?code=method-not-allowed', {
			method: 'PUT',
		});
		expect(res.status).toBe(405);
		expect(await res.json()).toEqual({ error: 'method not allowed', category: 'not_allowed' });
	});
});

describe('POST /replies?code=', () => {
	it('stores a Reply with server fields and returns the complete record', async () => {
		const code = 'reply-stores';
		const note = await createNote(code);
		const before = Date.now();
		const res = await postReply(code, replyBody(note.id, { clientId: 'buddy222', name: 'sam', id: 'forged', createdAt: 1 }));
		const after = Date.now();
		expect(res.status).toBe(200);
		const { ok, reply } = (await res.json()) as { ok: boolean; reply: Record<string, unknown> };
		expect(ok).toBe(true);
		expect(reply.id).not.toBe('forged');
		expect(reply).toMatchObject({ noteId: note.id, clientId: 'buddy222', name: 'sam', body: 'nice one' });
		expect(reply.createdAt as number).toBeGreaterThanOrEqual(before);
		expect(reply.createdAt as number).toBeLessThanOrEqual(after);

		const raw = await env.PROGRESS.get(`${code}:reply:${note.id}:buddy222:${reply.id}`);
		expect(JSON.parse(raw!)).toEqual(reply);
	});

	it.each([
		['missing clientId', { clientId: undefined }],
		['missing body', { body: '' }],
		['oversized body', { body: 'x'.repeat(101) }],
	])('rejects %s with a validation category', async (_name, overrides) => {
		const code = 'reply-invalid';
		const note = await createNote(code);
		const res = await postReply(code, replyBody(note.id, overrides));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { category: string }).category).toBe('validation');
	});

	it('accepts a body of exactly 100 characters', async () => {
		const code = 'reply-boundary';
		const note = await createNote(code);
		expect((await postReply(code, replyBody(note.id, { body: 'x'.repeat(100) }))).status).toBe(200);
	});

	it('404s with missing_parent for an absent parent Note', async () => {
		const res = await postReply('reply-no-parent', replyBody('no-such-note'));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'note not found', category: 'missing_parent' });
	});

	it('rejects a Reply to a Reaction (emoji Note)', async () => {
		const code = 'reply-to-emoji';
		const note = await createNote(code, { kind: 'emoji', body: '\u{1F44D}' });
		const res = await postReply(code, replyBody(note.id));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'replies are only allowed on text notes', category: 'validation' });
	});

	it('coerces a missing name to ""', async () => {
		const code = 'reply-missing-name';
		const note = await createNote(code);
		const { name, ...payload } = replyBody(note.id);
		const res = await postReply(code, payload);
		const { reply } = (await res.json()) as { reply: { name: string } };
		expect(reply.name).toBe('');
	});

	it('caps a conversation at 10 Replies with reply_cap', async () => {
		const code = 'reply-cap';
		const note = await createNote(code);
		for (let i = 0; i < 10; i++) {
			expect((await postReply(code, replyBody(note.id, { body: `reply ${i}` }))).status).toBe(200);
		}
		const res = await postReply(code, replyBody(note.id, { body: 'the eleventh' }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'reply limit reached', category: 'reply_cap' });
	});

	it('best-effort cap: concurrent Replies may briefly overshoot 10 (accepted KV limitation)', async () => {
		const code = 'reply-cap-concurrent';
		const note = await createNote(code);
		for (let i = 0; i < 9; i++) {
			await postReply(code, replyBody(note.id, { body: `reply ${i}` }));
		}
		// Three concurrent writers each list ~9 existing Replies: with no KV
		// transactions the cap cannot be strictly serialized, so anywhere from 1
		// to all 3 may land. The invariant is only "at least the cap, bounded by
		// the concurrency" — the client tolerates the rare overage.
		const results = await Promise.all([1, 2, 3].map((i) => postReply(code, replyBody(note.id, { body: `concurrent ${i}` }))));
		const successes = results.filter((r) => r.status === 200).length;
		expect(successes).toBeGreaterThanOrEqual(1);
		const stored = await env.PROGRESS.list({ prefix: `${code}:reply:${note.id}:` });
		expect(stored.keys.length).toBe(9 + successes);
		expect(stored.keys.length).toBeGreaterThanOrEqual(10);
		expect(stored.keys.length).toBeLessThanOrEqual(12);
	});

	it('rejects a brand-new member when the Room is full', async () => {
		const code = 'reply-room-full';
		const note = await createNote(code, { clientId: 'm1' });
		for (const clientId of ['m2', 'm3', 'm4', 'm5']) await postPresence(code, { clientId });
		const res = await postReply(code, replyBody(note.id, { clientId: 'm6' }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'room full', category: 'room_full' });
	});

	it('extends the whole conversation lifetime from the latest Reply', async () => {
		const code = 'reply-ttl';
		const note = await createNote(code);
		const noteKey = `${code}:note:${note.clientId}:abc123:${note.id}`;
		// Shrink the parent's TTL to an hour, then post a Reply: the conversation
		// must be re-put together with a fresh 14-day horizon.
		await env.PROGRESS.put(noteKey, (await env.PROGRESS.get(noteKey))!, { expirationTtl: 3600 });
		await postReply(code, replyBody(note.id));

		const floor = Date.now() / 1000 + 13 * 24 * 3600;
		const noteListing = await env.PROGRESS.list({ prefix: `${code}:note:` });
		const replyListing = await env.PROGRESS.list({ prefix: `${code}:reply:${note.id}:` });
		for (const key of [...noteListing.keys, ...replyListing.keys]) {
			expect(key.expiration).toBeGreaterThan(floor);
		}
	});
});

describe('GET /conversation?code=', () => {
	it('returns the Note and its Replies oldest first', async () => {
		const code = 'conversation-read';
		const note = await createNote(code, { body: 'the parent' });
		for (const text of ['first', 'second', 'third']) {
			await postReply(code, replyBody(note.id, { body: text }));
		}

		const res = await getConversation(code, note.id);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { note: { id: string; body: string }; replies: { body: string; createdAt: number }[] };
		expect(data.note.id).toBe(note.id);
		expect(data.note.body).toBe('the parent');
		expect(data.replies.map((r) => r.body)).toEqual(['first', 'second', 'third']);
		const times = data.replies.map((r) => r.createdAt);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});

	it('rejects a missing noteId with 400', async () => {
		const res = await SELF.fetch('https://example.com/conversation?code=conversation-no-id');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'missing noteId', category: 'validation' });
	});

	it('404s with missing_parent when the Note is gone', async () => {
		const res = await getConversation('conversation-absent', 'no-such-note');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'note not found', category: 'missing_parent' });
	});
});

describe('Reply lifecycles', () => {
	it('GET / returns replies separately from notes and progress', async () => {
		const code = 'get-replies';
		await post(code, body());
		const note = await createNote(code);
		await postReply(code, replyBody(note.id, { clientId: 'buddy222' }));

		const data = (await (await SELF.fetch(`https://example.com/?code=${code}`)).json()) as {
			progress: unknown[];
			notes: unknown[];
			replies: { noteId: string; clientId: string }[];
		};
		expect(data.progress).toHaveLength(1);
		expect(data.notes).toHaveLength(1);
		expect(data.replies).toHaveLength(1);
		expect(data.replies[0]).toMatchObject({ noteId: note.id, clientId: 'buddy222' });
	});

	it('deleting a parent Note cascades to its Replies', async () => {
		const code = 'delete-cascades';
		const note = await createNote(code);
		await postReply(code, replyBody(note.id, { clientId: 'buddy222' }));
		await postReply(code, replyBody(note.id, { clientId: 'buddy333' }));

		const res = await deleteNote(code, note.clientId, note.id);
		expect(res.status).toBe(200);
		expect((await env.PROGRESS.list({ prefix: `${code}:reply:` })).keys).toHaveLength(0);
	});

	it("keeps the forbidden category on another member's delete attempt", async () => {
		const code = 'delete-forbidden-category';
		const note = await createNote(code);
		const res = await deleteNote(code, 'someone-else', note.id);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { category: string }).category).toBe('forbidden');
	});

	it("leaving a Room deletes the member's Notes with their whole conversations", async () => {
		const code = 'leave-cascades-own';
		const note = await createNote(code, { clientId: 'author11' });
		await postReply(code, replyBody(note.id, { clientId: 'buddy222' }));

		await deleteMember(code, 'author11');
		expect((await env.PROGRESS.list({ prefix: `${code}:note:` })).keys).toHaveLength(0);
		expect((await env.PROGRESS.list({ prefix: `${code}:reply:` })).keys).toHaveLength(0);
	});

	it("leaving a Room deletes only the member's Replies under other authors' Notes", async () => {
		const code = 'leave-prunes-replies';
		const note = await createNote(code, { clientId: 'author11' });
		await postReply(code, replyBody(note.id, { clientId: 'leaver55', body: 'mine goes' }));
		await postReply(code, replyBody(note.id, { clientId: 'buddy222', body: 'this stays' }));

		await deleteMember(code, 'leaver55');
		expect((await env.PROGRESS.list({ prefix: `${code}:note:` })).keys).toHaveLength(1);
		const remaining = await env.PROGRESS.list({ prefix: `${code}:reply:${note.id}:` });
		expect(remaining.keys.map(({ name }) => name.split(':')[3])).toEqual(['buddy222']);
	});

	it('reply cleanup on leave crosses paginated listings', async () => {
		const code = 'leave-replies-paginated';
		await Promise.all(
			Array.from({ length: 501 }, (_, i) =>
				env.PROGRESS.put(
					`${code}:reply:note-${String(i).padStart(4, '0')}:leaver55:reply-${i}`,
					JSON.stringify({ id: `reply-${i}`, noteId: `note-${i}`, clientId: 'leaver55', name: '', body: 'x', createdAt: Date.now() }),
				),
			),
		);
		await env.PROGRESS.put(
			`${code}:reply:note-keep:buddy222:reply-keep`,
			JSON.stringify({ id: 'reply-keep', noteId: 'note-keep', clientId: 'buddy222', name: '', body: 'x', createdAt: Date.now() }),
		);

		const res = await deleteMember(code, 'leaver55');
		expect(res.status).toBe(200);
		const remaining = await env.PROGRESS.list({ prefix: `${code}:reply:` });
		expect(remaining.keys.map(({ name }) => name)).toEqual([`${code}:reply:note-keep:buddy222:reply-keep`]);
	}, 30_000);

	it('counts a Reply author as a Room member for the cap', async () => {
		const code = 'reply-author-counts';
		const note = await createNote(code, { clientId: 'author11' });
		await postReply(code, replyBody(note.id, { clientId: 'replier2' }));
		for (const clientId of ['m3', 'm4', 'm5']) await postPresence(code, { clientId });

		const res = await postPresence(code, { clientId: 'm6' });
		expect(res.status).toBe(409);
	});
});
