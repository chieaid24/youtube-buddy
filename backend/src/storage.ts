import { MAX_EVENTS, MAX_MEMBERS, TTL_SECONDS } from './constants';
import type { Env } from './types';

// Reports whether a Client ID may write into the Room. Returning members keep
// their slot; a brand-new member needs the current distinct count to be below
// MAX_MEMBERS. Membership is derived under the Code's prefix.
// Every key kind reserves a slot: progress keys are
// `${code}:${clientId}:${videoId}` (member id is the first segment), presence
// keys are `${code}:presence:${clientId}`, note keys are
// `${code}:note:${clientId}:${videoId}:${id}`, and reply keys are
// `${code}:reply:${noteId}:${clientId}:${id}` (member id is the third segment)
// — all readable from the key name alone. Caller input validation guarantees
// these segments contain no delimiter and Client IDs cannot equal an infix.
// Playlist keys
// (`${code}:playlist:${videoId}`) and event keys (`${code}:event:${ts}:${id}`)
// carry no member id, so those few values (<= 30 + ~50, both capped) are read
// for their `addedBy` / `actorClientId` — keeping a locked-out 6th person from
// curating the list. KV is eventually consistent with no transactions, so a
// simultaneous-join race (or a >1000-key code whose listing truncates) can
// momentarily admit a 6th member; acceptable for a friends-only weak-secret app.
export async function roomHasCapacityFor(env: Env, prefix: string, clientId: string): Promise<boolean> {
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
	return members.has(clientId) || members.size < MAX_MEMBERS;
}

// One Playlist Event backs one System Message in the Room Feed. Only
// recommends are recorded — un-recommending emits nothing (ADR-0007) — and the
// event captures the video's `title` at recommend time so the Feed line
// survives the Playlist Item's later removal. The key embeds a zero-padded
// millisecond timestamp so KV's lexicographic listing order is chronological;
// the log keeps only the newest MAX_EVENTS, pruned best-effort from the front
// on each write, and ages out on the shared TTL. The timestamp is bumped past
// the newest existing event when two writes land in the same millisecond, so
// sequential recommends always order correctly (best-effort under concurrency,
// like every cap here).
export async function recordPlaylistEvent(env: Env, prefix: string, videoId: string, title: string, actorClientId: string): Promise<void> {
	const eventPrefix = `${prefix}event:`;
	const listing = await env.PROGRESS.list({ prefix: eventPrefix });
	const lastKey = listing.keys.length > 0 ? listing.keys[listing.keys.length - 1].name : null;
	const lastAt = lastKey ? Number(lastKey.slice(eventPrefix.length).split(':')[0]) || 0 : 0;
	const at = Math.max(Date.now(), lastAt + 1);
	const id = crypto.randomUUID();
	const record = { id, type: 'added', videoId, title, actorClientId, at };
	await env.PROGRESS.put(`${eventPrefix}${String(at).padStart(14, '0')}:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
	const excess = listing.keys.length + 1 - MAX_EVENTS;
	if (excess > 0) {
		await Promise.all(listing.keys.slice(0, excess).map(({ name }) => env.PROGRESS.delete(name)));
	}
}

// Walk a KV prefix listing to completion and collect every key name. Use this
// when the names must all be in hand before acting on them — when the action
// only streams (delete every match) prefer deleteKeysWithPrefix, which keeps a
// single page in memory.
export async function listAllKeyNames(env: Env, prefix: string): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.PROGRESS.list({ prefix, cursor, limit: 500 });
		for (const { name } of page.keys) {
			names.push(name);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return names;
}

export async function deleteMember(env: Env, prefix: string, clientId: string): Promise<void> {
	// Cascade the member's own conversations first: collect their Note ids
	// (last key segment), then drop each Note's Replies wholesale.
	const ownNoteKeys = await listAllKeyNames(env, `${prefix}note:${clientId}:`);
	const ownNoteIds = ownNoteKeys.map((name) => {
		const parts = name.split(':');
		return parts[parts.length - 1];
	});
	await Promise.all(ownNoteIds.map((noteId) => deleteKeysWithPrefix(env, `${prefix}reply:${noteId}:`)));

	// Replies the member left under OTHER authors' Notes: the author sits in the
	// third key segment (`reply:${noteId}:${clientId}:${id}`), so no value reads.
	// The listing completes before any delete, so the scan never races its own
	// mutations.
	const replyKeys = await listAllKeyNames(env, `${prefix}reply:`);
	await Promise.all(
		replyKeys.filter((name) => name.slice(prefix.length).split(':')[2] === clientId).map((name) => env.PROGRESS.delete(name)),
	);

	await deleteKeysWithPrefix(env, `${prefix}${clientId}:`);
	await env.PROGRESS.delete(`${prefix}presence:${clientId}`);
	await deleteKeysWithPrefix(env, `${prefix}note:${clientId}:`);
}

export async function deleteKeysWithPrefix(env: Env, prefix: string): Promise<void> {
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

export async function findNoteKey(env: Env, prefix: string, id: string): Promise<string | null> {
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
export async function listReplies(env: Env, prefix: string, noteId: string): Promise<Array<{ createdAt: number; id: string }>> {
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
