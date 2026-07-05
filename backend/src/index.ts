interface Env {
	PROGRESS: KVNamespace;
}

interface ProgressBody {
	clientId: string;
	name: string;
	videoId: string;
	timestamp: number;
	duration: number;
}

interface PresenceBody {
	clientId: string;
	name: string;
}

interface NoteBody {
	clientId: string;
	name: string;
	videoId: string;
	timestamp: number;
	kind: 'text' | 'emoji';
	body: string;
	spoiler: boolean;
	mentions?: string[];
}

interface ReplyBody {
	clientId: string;
	name: string;
	noteId: string;
	body: string;
	mentions?: string[];
}

interface PlaylistBody {
	clientId: string;
	name: string;
	videoId: string;
	title: string;
}

export const NOTE_EMOJIS = ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}'] as const;

// Progress Records age out 14 days after their last write. Active videos keep
// getting rewritten so they never expire; abandoned ones drop, which also
// bounds the GET prefix scan. Presence Records share the same TTL. A Note
// conversation (the parent Note plus its Replies) is refreshed as a unit on
// every new Reply, so no orphan Reply outlives its parent.
const TTL_SECONDS = 14 * 24 * 3600;

// A Room Code is one Room of at most this many distinct Client IDs (you +
// up to 4 Buddies). Enforced best-effort on POST — see the cap check below.
const MAX_MEMBERS = 5;

// A text Note (and each Reply) is a short message, not an essay.
const NOTE_MAX_CHARS = 100;

// A Note conversation holds at most this many Replies. Best-effort under KV's
// eventual consistency: a concurrent race can momentarily admit an 11th; the
// client tolerates the rare overage.
const MAX_REPLIES = 10;

// The Shared Playlist holds at most this many distinct videos per Room; a
// member must remove one before another fits. Best-effort like every other
// cap here (no KV transactions).
const MAX_PLAYLIST_ITEMS = 30;

// Playlist Events (the log behind System Messages) keep only the newest ~50;
// older ones are pruned best-effort on each write. They also share TTL_SECONDS.
const MAX_EVENTS = 50;

// A Playlist Item's title is captured at add time; YouTube titles top out
// around 100 chars, so this bound only rejects abuse, never real titles.
const TITLE_MAX_CHARS = 200;

// Stable machine-readable error categories. The extension branches on these —
// never on the prose in `error`.
type ErrorCategory = 'validation' | 'room_full' | 'reply_cap' | 'missing_parent' | 'forbidden' | 'not_allowed' | 'unexpected' | 'playlist_full';

const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

interface LogContext {
	op: string;
	requestId: string;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const log: LogContext = { op: `${req.method} ${url.pathname}`, requestId: crypto.randomUUID() };
		try {
			return await route(req, env, url, log);
		} catch (err) {
			// Unexpected storage/parse/server failure: log loudly (no Room Codes,
			// Client IDs, names, or note text — the message is exception prose only).
			console.error(
				JSON.stringify({
					op: log.op,
					category: 'unexpected',
					status: 500,
					requestId: log.requestId,
					message: err instanceof Error ? err.message : String(err),
				}),
			);
			return json({ error: 'unexpected error', category: 'unexpected' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL, log: LogContext): Promise<Response> {
	// Preflight, for any path.
	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	const code = url.searchParams.get('code');
	if (!code) {
		return fail(log, 400, 'validation', 'missing code');
	}

	const prefix = `${code}:`;
	const path = url.pathname;

	// Presence: a member appears the instant they join a Code, independent of
	// whether they're watching anything. Stored under `${code}:presence:${id}`.
	if (req.method === 'POST' && path === '/presence') {
		const body = (await req.json()) as Partial<PresenceBody>;
		if (typeof body.clientId !== 'string' || body.clientId === '') {
			return fail(log, 400, 'validation', 'missing or invalid field: clientId');
		}

		// A presence row reserves a Room slot just like a progress row — see the
		// cap-check note in currentMembers.
		const members = await currentMembers(env, prefix);
		if (!members.has(body.clientId) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		// updatedAt is server-authoritative; name is optional (coerced to "").
		const record = {
			clientId: body.clientId,
			name: typeof body.name === 'string' ? body.name : '',
			updatedAt: Date.now(),
		};
		await env.PROGRESS.put(`${prefix}presence:${body.clientId}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
		return json({ ok: true });
	}

	// Leaving a Room removes the member completely: their presence row, all
	// Progress Records, their Notes (each with its whole conversation), and
	// every Reply they left under other authors' Notes — across every page of
	// the KV listing. Deleting absent keys is harmless, so it's idempotent.
	if (req.method === 'DELETE' && path === '/member') {
		const clientId = url.searchParams.get('clientId');
		if (!clientId) {
			return fail(log, 400, 'validation', 'missing clientId');
		}
		await deleteMember(env, prefix, clientId);
		return json({ ok: true });
	}

	// The Shared Playlist: one Room-level list keyed by videoId
	// (`${code}:playlist:${videoId}`), so re-adding dedups naturally and removal
	// is a point delete. Items are Room-communal — no per-item ownership.
	if (req.method === 'POST' && path === '/playlist') {
		const body = (await req.json()) as Partial<PlaylistBody>;
		const error = validatePlaylist(body);
		if (error) {
			return fail(log, 400, 'validation', error);
		}

		const members = await currentMembers(env, prefix);
		if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const key = `${prefix}playlist:${body.videoId}`;
		const existingRaw = await env.PROGRESS.get(key);
		if (existingRaw !== null) {
			// Re-adding an existing video is a no-op: no duplicate, no new Event.
			return json({ ok: true, item: JSON.parse(existingRaw) });
		}

		const listing = await env.PROGRESS.list({ prefix: `${prefix}playlist:` });
		if (listing.keys.length >= MAX_PLAYLIST_ITEMS) {
			return fail(log, 409, 'playlist_full', 'playlist full');
		}

		// addedAt is server-authoritative; name is optional (coerced to "").
		const item = {
			videoId: body.videoId,
			title: body.title,
			addedBy: body.clientId,
			addedByName: typeof body.name === 'string' ? body.name : '',
			addedAt: Date.now(),
		};
		await env.PROGRESS.put(key, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
		await recordPlaylistEvent(env, prefix, 'added', body.videoId!, body.clientId!);
		return json({ ok: true, item });
	}

	// Any member may remove any Playlist Item (the list belongs to the Room).
	// Idempotent: deleting an absent video is ok with no Event. The actor's
	// clientId is required for the `removed` Event, and a brand-new clientId is
	// still cap-gated so a locked-out 6th person cannot curate the list.
	if (req.method === 'DELETE' && path === '/playlist') {
		const clientId = url.searchParams.get('clientId');
		const videoId = url.searchParams.get('videoId');
		if (!clientId || !videoId) {
			return fail(log, 400, 'validation', `missing ${!clientId ? 'clientId' : 'videoId'}`);
		}

		const members = await currentMembers(env, prefix);
		if (!members.has(clientId) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const key = `${prefix}playlist:${videoId}`;
		const existing = await env.PROGRESS.get(key);
		if (existing === null) return json({ ok: true });
		await env.PROGRESS.delete(key);
		await recordPlaylistEvent(env, prefix, 'removed', videoId, clientId);
		return json({ ok: true });
	}

	if (req.method === 'POST' && path === '/notes') {
		const body = (await req.json()) as Partial<NoteBody>;
		const error = validateNote(body);
		if (error) {
			return fail(log, 400, 'validation', error);
		}

		const members = await currentMembers(env, prefix);
		if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const id = crypto.randomUUID();
		const record = {
			id,
			clientId: body.clientId,
			name: typeof body.name === 'string' ? body.name : '',
			videoId: body.videoId,
			timestamp: body.timestamp,
			kind: body.kind,
			body: body.body,
			spoiler: body.spoiler ?? false,
			// Mentions are stored Client IDs, never display-name text (ADR-0006).
			// Absent means no mentions — older clients and records stay valid.
			...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
			createdAt: Date.now(),
		};
		await env.PROGRESS.put(`${prefix}note:${body.clientId}:${body.videoId}:${id}`, JSON.stringify(record), {
			expirationTtl: TTL_SECONDS,
		});
		// The complete server-authoritative record: the extension inserts it into
		// the active Video Timeline immediately, without inventing server fields.
		return json({ ok: true, id, note: record });
	}

	// Deleting a parent Note deletes its whole conversation: every Reply under
	// it goes too, so no orphan Reply outlives its parent (ADR-0003 ownership).
	if (req.method === 'DELETE' && path === '/notes') {
		const clientId = url.searchParams.get('clientId');
		const id = url.searchParams.get('id');
		if (!clientId || !id) {
			return fail(log, 400, 'validation', `missing ${!clientId ? 'clientId' : 'id'}`);
		}

		const key = await findNoteKey(env, prefix, id);
		if (!key) return json({ ok: true });
		const raw = await env.PROGRESS.get(key);
		if (raw === null) return json({ ok: true });
		const note = JSON.parse(raw) as { clientId?: unknown };
		if (note.clientId !== clientId) {
			return fail(log, 403, 'forbidden', 'forbidden', { noteId: id });
		}
		await env.PROGRESS.delete(key);
		await deleteKeysWithPrefix(env, `${prefix}reply:${id}:`);
		return json({ ok: true });
	}

	// A Reply: a short text-only child of one existing text Note. Stored under
	// `${code}:reply:${noteId}:${authorClientId}:${replyId}` so a conversation
	// is one prefix scan and a member's Replies are removable without value
	// reads. Posting one extends the whole conversation's lifetime.
	if (req.method === 'POST' && path === '/replies') {
		const body = (await req.json()) as Partial<ReplyBody>;
		const error = validateReply(body);
		if (error) {
			return fail(log, 400, 'validation', error);
		}

		const noteKey = await findNoteKey(env, prefix, body.noteId!);
		const noteRaw = noteKey ? await env.PROGRESS.get(noteKey) : null;
		if (noteRaw === null) {
			return fail(log, 404, 'missing_parent', 'note not found', { noteId: body.noteId! });
		}
		const note = JSON.parse(noteRaw) as { kind?: unknown };
		if (note.kind !== 'text') {
			return fail(log, 400, 'validation', 'replies are only allowed on text notes', { noteId: body.noteId! });
		}

		const members = await currentMembers(env, prefix);
		if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const replyPrefix = `${prefix}reply:${body.noteId}:`;
		const existing = await env.PROGRESS.list({ prefix: replyPrefix });
		if (existing.keys.length >= MAX_REPLIES) {
			return fail(log, 409, 'reply_cap', 'reply limit reached', { noteId: body.noteId! });
		}

		const id = crypto.randomUUID();
		const record = {
			id,
			noteId: body.noteId,
			clientId: body.clientId,
			name: typeof body.name === 'string' ? body.name : '',
			body: body.body,
			...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
			createdAt: Date.now(),
		};
		await env.PROGRESS.put(`${replyPrefix}${body.clientId}:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });

		// Extend the conversation's lifetime to 14 days from this latest Reply:
		// re-put the parent and every prior Reply (bounded by MAX_REPLIES) with a
		// fresh TTL, together, so nothing in the conversation outlives its parent.
		await Promise.all([
			env.PROGRESS.put(noteKey!, noteRaw, { expirationTtl: TTL_SECONDS }),
			...existing.keys.map(async ({ name }) => {
				const raw = await env.PROGRESS.get(name);
				if (raw !== null) await env.PROGRESS.put(name, raw, { expirationTtl: TTL_SECONDS });
			}),
		]);
		return json({ ok: true, reply: record });
	}

	// Focused conversation read: one Note plus its Replies (oldest first), so an
	// open Expanded Note can poll every 5s without pulling the whole Room.
	if (req.method === 'GET' && path === '/conversation') {
		const noteId = url.searchParams.get('noteId');
		if (!noteId) {
			return fail(log, 400, 'validation', 'missing noteId');
		}
		const noteKey = await findNoteKey(env, prefix, noteId);
		const noteRaw = noteKey ? await env.PROGRESS.get(noteKey) : null;
		if (noteRaw === null) {
			return fail(log, 404, 'missing_parent', 'note not found', { noteId });
		}
		return json({ note: JSON.parse(noteRaw), replies: await listReplies(env, prefix, noteId) });
	}

	if (req.method === 'POST' && path === '/') {
		const body = (await req.json()) as Partial<ProgressBody>;
		const error = validate(body);
		if (error) {
			return fail(log, 400, 'validation', error);
		}

		// Best-effort Room cap: a Room Code holds at most MAX_MEMBERS distinct
		// Client IDs, counting both progress and presence rows. A brand-new
		// Client ID is rejected once the Room is full; returning members — and
		// their new videos — always go through. See currentMembers.
		const members = await currentMembers(env, prefix);
		if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
			return fail(log, 409, 'room_full', 'room full');
		}

		// updatedAt is server-authoritative — never trust the client's value.
		const key = `${prefix}${body.clientId}:${body.videoId}`;
		const record = {
			clientId: body.clientId,
			name: body.name ?? '',
			videoId: body.videoId,
			timestamp: body.timestamp,
			duration: body.duration,
			updatedAt: Date.now(),
		};
		await env.PROGRESS.put(key, JSON.stringify(record), {
			expirationTtl: TTL_SECONDS,
		});
		return json({ ok: true });
	}

	if (req.method === 'GET' && path === '/') {
		// One prefix scan over every kind; partition by key shape. Presence keys
		// carry the "presence" infix (`${code}:presence:${id}`), Notes the "note"
		// infix, Replies the "reply" infix, Playlist Items the "playlist" infix,
		// Playlist Events the "event" infix; everything else is a progress key
		// (`${code}:${id}:${videoId}`). Replies ride along so the client can pair
		// them with parent Notes and show Reply counts on Note Previews.
		const list = await env.PROGRESS.list({ prefix });
		const progress: unknown[] = [];
		const presence: unknown[] = [];
		const notes: unknown[] = [];
		const replies: unknown[] = [];
		const playlist: unknown[] = [];
		const events: unknown[] = [];
		const buckets: Record<string, unknown[]> = { presence, note: notes, reply: replies, playlist, event: events };
		await Promise.all(
			list.keys.map(async (k) => {
				const value = await env.PROGRESS.get(k.name);
				if (value === null) return;
				const kind = k.name.slice(prefix.length).split(':')[0];
				(buckets[kind] ?? progress).push(JSON.parse(value));
			}),
		);
		return json({ progress, presence, notes, replies, playlist, events });
	}

	return fail(log, 405, 'not_allowed', 'method not allowed');
}

// Derives the Room's current distinct Client IDs under the Code's prefix.
// Every key kind reserves a slot: progress keys are
// `${code}:${clientId}:${videoId}` (member id is the first segment), presence
// keys are `${code}:presence:${clientId}`, note keys are
// `${code}:note:${clientId}:${videoId}:${id}`, and reply keys are
// `${code}:reply:${noteId}:${clientId}:${id}` (member id is the third segment)
// — all readable from the key name alone. Playlist keys
// (`${code}:playlist:${videoId}`) and event keys (`${code}:event:${ts}:${id}`)
// carry no member id, so those few values (<= 30 + ~50, both capped) are read
// for their `addedBy` / `actorClientId` — keeping a locked-out 6th person from
// curating the list. The infixes can never collide with a Client ID (8 hex
// chars). KV is eventually consistent with no transactions, so a
// simultaneous-join race (or a >1000-key code whose listing truncates) can
// momentarily admit a 6th member; acceptable for a friends-only weak-secret app.
async function currentMembers(env: Env, prefix: string): Promise<Set<string>> {
	const existing = await env.PROGRESS.list({ prefix });
	const members = new Set<string>();
	const valueReads: string[] = [];
	for (const k of existing.keys) {
		const parts = k.name.slice(prefix.length).split(':');
		if (parts[0] === 'playlist' || parts[0] === 'event') {
			valueReads.push(k.name);
			continue;
		}
		members.add(parts[0] === 'reply' ? parts[2] : parts[0] === 'presence' || parts[0] === 'note' ? parts[1] : parts[0]);
	}
	await Promise.all(
		valueReads.map(async (name) => {
			const raw = await env.PROGRESS.get(name);
			if (raw === null) return;
			const record = JSON.parse(raw) as { addedBy?: unknown; actorClientId?: unknown };
			const id = record.addedBy ?? record.actorClientId;
			if (typeof id === 'string' && id !== '') members.add(id);
		}),
	);
	return members;
}

// One Playlist Event backs one System Message in the Room Feed. The key embeds
// a zero-padded millisecond timestamp so KV's lexicographic listing order is
// chronological; the log keeps only the newest MAX_EVENTS, pruned best-effort
// from the front on each write, and ages out on the shared TTL. The timestamp
// is bumped past the newest existing event when two writes land in the same
// millisecond, so sequential adds/removes always order correctly (best-effort
// under concurrency, like every cap here).
async function recordPlaylistEvent(env: Env, prefix: string, type: 'added' | 'removed', videoId: string, actorClientId: string): Promise<void> {
	const eventPrefix = `${prefix}event:`;
	const listing = await env.PROGRESS.list({ prefix: eventPrefix });
	const lastKey = listing.keys.length > 0 ? listing.keys[listing.keys.length - 1].name : null;
	const lastAt = lastKey ? Number(lastKey.slice(eventPrefix.length).split(':')[0]) || 0 : 0;
	const at = Math.max(Date.now(), lastAt + 1);
	const id = crypto.randomUUID();
	const record = { id, type, videoId, actorClientId, at };
	await env.PROGRESS.put(`${eventPrefix}${String(at).padStart(14, '0')}:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
	const excess = listing.keys.length + 1 - MAX_EVENTS;
	if (excess > 0) {
		await Promise.all(listing.keys.slice(0, excess).map(({ name }) => env.PROGRESS.delete(name)));
	}
}

async function deleteMember(env: Env, prefix: string, clientId: string): Promise<void> {
	// Cascade the member's own conversations first: collect their Note ids
	// (last key segment), then drop each Note's Replies wholesale.
	const ownNoteIds: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.PROGRESS.list({ prefix: `${prefix}note:${clientId}:`, cursor, limit: 500 });
		for (const { name } of page.keys) {
			const parts = name.split(':');
			ownNoteIds.push(parts[parts.length - 1]);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	await Promise.all(ownNoteIds.map((noteId) => deleteKeysWithPrefix(env, `${prefix}reply:${noteId}:`)));

	// Replies the member left under OTHER authors' Notes: the author sits in the
	// third key segment (`reply:${noteId}:${clientId}:${id}`), so no value reads.
	cursor = undefined;
	do {
		const page = await env.PROGRESS.list({ prefix: `${prefix}reply:`, cursor, limit: 500 });
		await Promise.all(
			page.keys.filter(({ name }) => name.slice(prefix.length).split(':')[2] === clientId).map(({ name }) => env.PROGRESS.delete(name)),
		);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	await deleteKeysWithPrefix(env, `${prefix}${clientId}:`);
	await env.PROGRESS.delete(`${prefix}presence:${clientId}`);
	await deleteKeysWithPrefix(env, `${prefix}note:${clientId}:`);
}

async function deleteKeysWithPrefix(env: Env, prefix: string): Promise<void> {
	let cursor: string | undefined;

	do {
		const page = await env.PROGRESS.list({
			prefix,
			cursor,
			limit: 500,
		});
		await Promise.all(page.keys.map(({ name }) => env.PROGRESS.delete(name)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
}

async function findNoteKey(env: Env, prefix: string, id: string): Promise<string | null> {
	let cursor: string | undefined;
	do {
		const page = await env.PROGRESS.list({ prefix: `${prefix}note:`, cursor });
		const match = page.keys.find(({ name }) => name.endsWith(`:${id}`));
		if (match) return match.name;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return null;
}

// One conversation's Replies, oldest first (createdAt, then id for stability).
async function listReplies(env: Env, prefix: string, noteId: string): Promise<Array<{ createdAt: number; id: string }>> {
	const replies: Array<{ createdAt: number; id: string }> = [];
	let cursor: string | undefined;
	do {
		const page = await env.PROGRESS.list({ prefix: `${prefix}reply:${noteId}:`, cursor });
		await Promise.all(
			page.keys.map(async ({ name }) => {
				const raw = await env.PROGRESS.get(name);
				if (raw !== null) replies.push(JSON.parse(raw));
			}),
		);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	replies.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
	return replies;
}

// Returns an error message for an invalid POST body, or null if it is valid.
// `name` is intentionally NOT required: Display Name is optional (a blank name
// still shares; consumers render a stable "<Adjective> Buddy" fallback derived
// from clientId — see YTB.buddyName). Missing/empty name is coerced to "" on
// store.
function validate(body: Partial<ProgressBody>): string | null {
	for (const field of ['clientId', 'videoId'] as const) {
		if (typeof body[field] !== 'string' || body[field] === '') {
			return `missing or invalid field: ${field}`;
		}
	}
	for (const field of ['timestamp', 'duration'] as const) {
		if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
			return `missing or invalid field: ${field}`;
		}
	}
	return null;
}

function validateNote(body: Partial<NoteBody>): string | null {
	for (const field of ['clientId', 'videoId', 'body'] as const) {
		if (typeof body[field] !== 'string' || body[field] === '') {
			return `missing or invalid field: ${field}`;
		}
	}
	if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
		return 'missing or invalid field: timestamp';
	}
	if (body.kind !== 'text' && body.kind !== 'emoji') {
		return 'missing or invalid field: kind';
	}
	if (body.kind === 'text' && body.body.length > NOTE_MAX_CHARS) {
		return `text body exceeds ${NOTE_MAX_CHARS} characters`;
	}
	if (body.kind === 'emoji' && !(NOTE_EMOJIS as readonly string[]).includes(body.body)) {
		return 'invalid emoji body';
	}
	if (body.spoiler !== undefined && typeof body.spoiler !== 'boolean') {
		return 'missing or invalid field: spoiler';
	}
	// A Reaction is never a Spoiler — reject the contradiction instead of
	// silently persisting it.
	if (body.kind === 'emoji' && body.spoiler === true) {
		return 'a reaction cannot be a spoiler';
	}
	return validateMentions(body.mentions);
}

function validateReply(body: Partial<ReplyBody>): string | null {
	for (const field of ['clientId', 'noteId', 'body'] as const) {
		if (typeof body[field] !== 'string' || body[field] === '') {
			return `missing or invalid field: ${field}`;
		}
	}
	if (body.body!.length > NOTE_MAX_CHARS) {
		return `reply body exceeds ${NOTE_MAX_CHARS} characters`;
	}
	return validateMentions(body.mentions);
}

// Mentions are OPTIONAL (absent = none, keeping older clients and stored
// records valid). When present: an array of nonempty Client ID strings,
// bounded by the Room cap — a Note can never mention more people than a Room
// holds (ADR-0006).
function validateMentions(mentions: unknown): string | null {
	if (mentions === undefined) return null;
	if (!Array.isArray(mentions) || mentions.length > MAX_MEMBERS || mentions.some((m) => typeof m !== 'string' || m === '')) {
		return 'missing or invalid field: mentions';
	}
	return null;
}

function validatePlaylist(body: Partial<PlaylistBody>): string | null {
	for (const field of ['clientId', 'videoId', 'title'] as const) {
		if (typeof body[field] !== 'string' || body[field] === '') {
			return `missing or invalid field: ${field}`;
		}
	}
	if (body.title!.length > TITLE_MAX_CHARS) {
		return `title exceeds ${TITLE_MAX_CHARS} characters`;
	}
	return null;
}

// Log-and-respond for every expected failure. The structured line carries the
// route/op, category, status, request id, and only OPAQUE identifiers (server-
// generated UUIDs) — never Room Codes, Client IDs, Display Names, or text.
// Expected client failures log at info; 5xx logs at error (see fetch).
function fail(log: LogContext, status: number, category: ErrorCategory, error: string, ids?: Record<string, string>): Response {
	const line = JSON.stringify({ op: log.op, category, status, requestId: log.requestId, ...ids });
	if (status >= 500) console.error(line);
	else console.log(line);
	return json({ error, category }, status);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}
