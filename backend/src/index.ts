import { MAX_PLAYLIST_ITEMS, MAX_REPLIES, TTL_SECONDS } from './constants';
import { corsHeaders, fail, json } from './http';
import { deleteKeysWithPrefix, deleteMember, findNoteKey, listReplies, recordPlaylistEvent, roomHasCapacityFor } from './storage';
import type { Env, LogContext, NoteBody, PlaylistBody, PresenceBody, ProgressBody, ReplyBody } from './types';
import {
	isValidClientId,
	isValidKeySegment,
	sanitizeVideoTitle,
	validate,
	validateNote,
	validatePlaylist,
	validateReply,
} from './validation';

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
	if (!isValidKeySegment(code)) {
		return fail(log, 400, 'validation', 'missing or invalid field: code');
	}

	const prefix = `${code}:`;
	const path = url.pathname;

	// Presence: a member appears the instant they join a Code, independent of
	// whether they're watching anything. Stored under `${code}:presence:${id}`.
	if (req.method === 'POST' && path === '/presence') {
		const body = (await req.json()) as Partial<PresenceBody>;
		if (!isValidClientId(body.clientId)) {
			return fail(log, 400, 'validation', 'missing or invalid field: clientId');
		}

		// A presence row reserves a Room slot just like a progress row.
		if (!(await roomHasCapacityFor(env, prefix, body.clientId))) {
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
		if (!isValidClientId(clientId)) {
			return fail(log, 400, 'validation', 'missing or invalid field: clientId');
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

		if (!(await roomHasCapacityFor(env, prefix, body.clientId!))) {
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

		// A server-minted id names one recommendation INSTANCE (ADR-0007): stable
		// while the item stays live (the no-op re-add above returns it unchanged),
		// freshly minted when a video is recommended again after an un-recommend
		// (delete then add), so a viewer's identity-keyed Dismiss resurfaces on a
		// re-recommend. addedAt is server-authoritative; name optional (-> "").
		const item = {
			id: crypto.randomUUID(),
			videoId: body.videoId,
			title: body.title,
			addedBy: body.clientId,
			addedByName: typeof body.name === 'string' ? body.name : '',
			addedAt: Date.now(),
		};
		await env.PROGRESS.put(key, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
		await recordPlaylistEvent(env, prefix, body.videoId!, body.title!, body.clientId!);
		return json({ ok: true, item });
	}

	// Any member may remove any Playlist Item (the list belongs to the Room).
	// Idempotent: deleting an absent video is ok. Removals emit NO Playlist
	// Event (ADR-0007: the recommend Feed line survives an un-recommend). The
	// actor's clientId is still required because a brand-new clientId is
	// cap-gated, so a locked-out 6th person cannot curate the list.
	if (req.method === 'DELETE' && path === '/playlist') {
		const clientId = url.searchParams.get('clientId');
		const videoId = url.searchParams.get('videoId');
		if (!clientId || !videoId) {
			return fail(log, 400, 'validation', `missing ${!clientId ? 'clientId' : 'videoId'}`);
		}
		if (!isValidClientId(clientId) || !isValidKeySegment(videoId)) {
			return fail(log, 400, 'validation', `missing or invalid field: ${!isValidClientId(clientId) ? 'clientId' : 'videoId'}`);
		}

		if (!(await roomHasCapacityFor(env, prefix, clientId))) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const key = `${prefix}playlist:${videoId}`;
		await env.PROGRESS.delete(key);
		return json({ ok: true });
	}

	if (req.method === 'POST' && path === '/notes') {
		const body = (await req.json()) as Partial<NoteBody>;
		const error = validateNote(body);
		if (error) {
			return fail(log, 400, 'validation', error);
		}

		if (!(await roomHasCapacityFor(env, prefix, body.clientId!))) {
			return fail(log, 409, 'room_full', 'room full');
		}

		const id = crypto.randomUUID();
		const videoTitle = sanitizeVideoTitle(body.videoTitle);
		const record = {
			id,
			clientId: body.clientId,
			name: typeof body.name === 'string' ? body.name : '',
			videoId: body.videoId,
			// The video's title, frozen at post time (like a Playlist Event's, see
			// recordPlaylistEvent). Absent means the poster had no title to give.
			...(videoTitle !== undefined ? { videoTitle } : {}),
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
		if (!isValidClientId(clientId) || !isValidKeySegment(id)) {
			return fail(log, 400, 'validation', `missing or invalid field: ${!isValidClientId(clientId) ? 'clientId' : 'id'}`);
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

		if (!(await roomHasCapacityFor(env, prefix, body.clientId!))) {
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
		if (!isValidKeySegment(noteId)) {
			return fail(log, 400, 'validation', 'missing or invalid field: noteId');
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
		// their new videos — always go through.
		if (!(await roomHasCapacityFor(env, prefix, body.clientId!))) {
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
				// Only the five reserved kinds have their own bucket; every other
				// first segment is a Progress Record's clientId and belongs in
				// progress. Match on OWN properties so a clientId that happens to
				// equal an inherited Object property name (e.g. "toString") routes
				// to progress instead of resolving a prototype member.
				const bucket = Object.hasOwn(buckets, kind) ? buckets[kind] : progress;
				bucket.push(JSON.parse(value));
			}),
		);
		return json({ progress, presence, notes, replies, playlist, events });
	}

	return fail(log, 405, 'not_allowed', 'method not allowed');
}
