import { beforeAll, describe, expect, it, vi } from 'vitest';

let storage: Record<string, unknown>;

describe('extension member API', () => {
	beforeAll(async () => {
		storage = {};
		Object.assign(globalThis, {
			window: globalThis,
			chrome: {
				storage: {
					local: {
						get: vi.fn(async (key: string | string[]) =>
							(Array.isArray(key) ? key : [key]).reduce<Record<string, unknown>>((result, item) => {
								result[item] = storage[item];
								return result;
							}, {}),
						),
						set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values)),
					},
				},
			},
		});
		await import('../../extension/shared.js');
	});

	it('allocates unique colors, persists them by Room, and isolates Rooms', async () => {
		storage = {};
		const values = [0, 0, 0, 0];
		const roomA = await window.YTB.syncBuddyColors('room-a', ['a', 'b', 'c', 'd'], true, () => values.shift()!);
		expect(new Set(Object.values(roomA))).toHaveLength(4);
		expect(storage.buddyColors).toMatchObject({ 'room-a': roomA });

		const roomB = await window.YTB.syncBuddyColors('room-b', ['a'], true, () => 0.99);
		expect(roomB.a).not.toBe(roomA.a);
		expect(storage.buddyColors).toMatchObject({ 'room-a': roomA, 'room-b': roomB });
	});

	it('preserves assignments on failure, cleans up on success, and allocates a fresh rejoin color', async () => {
		storage = {};
		const initial = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0);
		await window.YTB.syncBuddyColors('room', [], false);
		expect((storage.buddyColors as any).room).toEqual(initial);

		await window.YTB.syncBuddyColors('room', ['b'], true);
		expect((storage.buddyColors as any).room.a).toBeUndefined();
		const rejoined = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0.99);
		expect(rejoined.a).not.toBe(initial.a);
	});

	it('rejects assigning a color used by another current Buddy', async () => {
		storage = {};
		const room = await window.YTB.syncBuddyColors('room', ['a', 'b'], true, () => 0);
		await expect(window.YTB.setBuddyColor('room', 'b', room.a)).resolves.toBe(false);
	});

	it('clears only the Room the viewer leaves', async () => {
		storage = { buddyColors: { left: { a: '#00a6d6' }, kept: { b: '#f0a500' } } };
		await window.YTB.clearRoomColors('left');
		expect(storage.buddyColors).toEqual({ kept: { b: '#f0a500' } });
	});

	it('deletes the complete member through DELETE /member', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal('fetch', fetchMock);

		const result = await window.YTB.deleteMember('silly-otters', 'a1b2c3d4');

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/member?code=silly-otters&clientId=a1b2c3d4', { method: 'DELETE' });
	});

	it('recognizes a Room only when it has presence or progress records', () => {
		expect(window.YTB.roomExists({ progress: [], presence: [] })).toBe(false);
		expect(window.YTB.roomExists({ progress: [], presence: [{ clientId: 'present' }] })).toBe(true);
		expect(window.YTB.roomExists({ progress: [{ clientId: 'watching' }], presence: [] })).toBe(true);
	});

	it('returns Notes from the Room read and deletes an owned Note', async () => {
		const note = { id: 'note-1', clientId: 'a1b2c3d4', videoId: 'video', timestamp: 12 };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ progress: [], presence: [], notes: [note] }),
			})
			.mockResolvedValueOnce({ ok: true });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.getRecords('silly-otters')).resolves.toMatchObject({ notes: [note], ok: true });
		await expect(window.YTB.deleteNote('silly-otters', 'a1b2c3d4', 'note-1')).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:8787/notes?code=silly-otters&clientId=a1b2c3d4&id=note-1', {
			method: 'DELETE',
		});
	});

	it('posts a Note with the canonical payload and returns the complete server record', async () => {
		storage = { code: 'silly-otters' };
		const note = {
			clientId: 'a1b2c3d4',
			name: 'Sam',
			videoId: 'video',
			timestamp: 12.5,
			kind: 'text',
			body: 'great moment',
			spoiler: true,
		};
		const serverNote = { ...note, id: 'server-id', createdAt: 123 };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: 'server-id', note: serverNote }) });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.postNote(note)).resolves.toEqual({ ok: true, id: 'server-id', note: serverNote });
		expect(window.YTB.NOTE_EMOJIS).toEqual(['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}']);
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/notes?code=silly-otters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(note),
		});
	});

	it('maps write failures to machine-readable categories, never prose', async () => {
		storage = { code: 'silly-otters' };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'room full', category: 'room_full' }) }));
		await expect(window.YTB.postNote({ clientId: 'a', videoId: 'v', timestamp: 1, kind: 'text', body: 'x' })).resolves.toEqual({
			ok: false,
			category: 'room_full',
		});

		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
		await expect(window.YTB.postReply({ clientId: 'a', noteId: 'n', body: 'x' })).resolves.toEqual({
			ok: false,
			category: 'unexpected',
		});

		storage = { code: 'silly-otters', sharing: false };
		await expect(window.YTB.postNote({ clientId: 'a', videoId: 'v', timestamp: 1, kind: 'text', body: 'x' })).resolves.toEqual({
			ok: false,
			category: 'sharing_off',
		});
		await expect(window.YTB.postReply({ clientId: 'a', noteId: 'n', body: 'x' })).resolves.toEqual({
			ok: false,
			category: 'sharing_off',
		});
	});

	it('posts a Reply and returns the complete server record', async () => {
		storage = { code: 'silly-otters' };
		const reply = { id: 'r1', noteId: 'n1', clientId: 'a1b2c3d4', name: 'Sam', body: 'nice', createdAt: 456 };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, reply }) });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.postReply({ clientId: 'a1b2c3d4', name: 'Sam', noteId: 'n1', body: 'nice' })).resolves.toEqual({
			ok: true,
			reply,
		});
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/replies?code=silly-otters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ clientId: 'a1b2c3d4', name: 'Sam', noteId: 'n1', body: 'nice' }),
		});
	});

	it('reads a focused conversation and surfaces a deleted parent as missing_parent', async () => {
		const note = { id: 'n1', body: 'parent' };
		const replies = [{ id: 'r1' }, { id: 'r2' }];
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ note, replies }) }));
		await expect(window.YTB.getConversation('silly-otters', 'n1')).resolves.toEqual({ ok: true, note, replies });

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'note not found', category: 'missing_parent' }) }),
		);
		await expect(window.YTB.getConversation('silly-otters', 'n1')).resolves.toEqual({ ok: false, category: 'missing_parent' });
	});

	it('includes replies in Room reads', async () => {
		const replies = [{ id: 'r1', noteId: 'n1' }];
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ progress: [], presence: [], notes: [], replies }) }));
		await expect(window.YTB.getRecords('silly-otters')).resolves.toMatchObject({ replies, ok: true });
	});
});

describe('note presentation helpers', () => {
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	it('formats relative posting times, rounding down to the largest useful unit', () => {
		const now = 1_700_000_000_000;
		expect(window.YTB.relativeTime(now - 30_000, now)).toBe('just now');
		expect(window.YTB.relativeTime(now - 8 * MINUTE, now)).toBe('8 min ago');
		expect(window.YTB.relativeTime(now - 1 * HOUR - 25 * MINUTE, now)).toBe('1 hr ago');
		expect(window.YTB.relativeTime(now - 4 * DAY, now)).toBe('4 days ago');
		expect(window.YTB.relativeTime(now - 1 * DAY, now)).toBe('1 day ago');
		expect(window.YTB.relativeTime(now - 7 * DAY, now)).toBe('1 week ago');
		expect(window.YTB.relativeTime(now - 27 * DAY, now)).toBe('3 weeks ago');
		// After four weeks the label progresses to months, then years.
		expect(window.YTB.relativeTime(now - 28 * DAY, now)).toBe('1 month ago');
		expect(window.YTB.relativeTime(now - 70 * DAY, now)).toBe('2 months ago');
		expect(window.YTB.relativeTime(now - 400 * DAY, now)).toBe('1 year ago');
	});

	it('maps error categories to safe user copy', () => {
		expect(window.YTB.errorCopy('reply_cap', 'reply')).toBe('This note already has 10 replies.');
		expect(window.YTB.errorCopy('room_full', 'note')).toBe("This Room is full, so you can't post here.");
		expect(window.YTB.errorCopy('missing_parent', 'reply')).toBe('This note is no longer available.');
		expect(window.YTB.errorCopy('unexpected', 'note')).toBe("We couldn't post your note. Try again.");
		expect(window.YTB.errorCopy('validation', 'reply')).toBe("We couldn't post your reply. Try again.");
		expect(window.YTB.errorCopy('unexpected', 'reaction')).toBe("We couldn't post your reaction. Try again.");
	});

	it('writes the delete confirmation with the exact Reply cascade count', () => {
		expect(window.YTB.deleteConfirmCopy(0)).toBe('Really delete it?');
		expect(window.YTB.deleteConfirmCopy(1)).toBe('Really delete it? This will also delete 1 reply.');
		expect(window.YTB.deleteConfirmCopy(2)).toBe('Really delete it? This will also delete 2 replies.');
		expect(window.YTB.deleteConfirmCopy(10)).toBe('Really delete it? This will also delete 10 replies.');
		// Defensive coercion: junk counts read as "no Replies".
		expect(window.YTB.deleteConfirmCopy(-3)).toBe('Really delete it?');
		expect(window.YTB.deleteConfirmCopy(Number.NaN)).toBe('Really delete it?');
	});

	it('targets Go here at one second before the Note, clamped at zero', () => {
		expect(window.YTB.goHereTarget(42)).toBe(41);
		expect(window.YTB.goHereTarget(1)).toBe(0);
		expect(window.YTB.goHereTarget(0.4)).toBe(0);
		expect(window.YTB.goHereTarget(0)).toBe(0);
		expect(window.YTB.goHereTarget(Number.NaN)).toBe(0);
	});

	it('spreads dots within the 2-second window, preserving order and clamping to the bar', () => {
		// Two dots 1s apart at the same spot: separated by >= the gap, in order.
		const pair = window.YTB.spreadFractions([
			{ id: 'a', timestamp: 10, fraction: 0.5 },
			{ id: 'b', timestamp: 11, fraction: 0.5005 },
		]);
		expect(pair.get('a')!).toBeLessThan(pair.get('b')!);
		expect(pair.get('b')! - pair.get('a')!).toBeCloseTo(0.012, 5);

		// A cluster at the very start of the timeline stays inside [0,1].
		const edge = window.YTB.spreadFractions([
			{ id: 'a', timestamp: 0, fraction: 0 },
			{ id: 'b', timestamp: 1, fraction: 0.001 },
			{ id: 'c', timestamp: 2, fraction: 0.002 },
		]);
		for (const fraction of edge.values()) {
			expect(fraction).toBeGreaterThanOrEqual(0);
			expect(fraction).toBeLessThanOrEqual(1);
		}
		expect(edge.get('a')!).toBeLessThan(edge.get('b')!);
		expect(edge.get('b')!).toBeLessThan(edge.get('c')!);

		// Dots further than 2s apart keep their natural positions.
		const apart = window.YTB.spreadFractions([
			{ id: 'a', timestamp: 10, fraction: 0.2 },
			{ id: 'b', timestamp: 20, fraction: 0.4 },
		]);
		expect(apart.get('a')).toBe(0.2);
		expect(apart.get('b')).toBe(0.4);
	});

	it('detects natural playback crossings repeatedly, as a pure filter', () => {
		const notes = [{ timestamp: 10 }, { timestamp: 12 }, { timestamp: 30 }];
		expect(window.YTB.crossedNotes(notes, 9, 12.5).map((n: { timestamp: number }) => n.timestamp)).toEqual([10, 12]);
		// Rewinding and playing forward again crosses the same Note again.
		expect(window.YTB.crossedNotes(notes, 8, 10).map((n: { timestamp: number }) => n.timestamp)).toEqual([10]);
		// Nothing in the window.
		expect(window.YTB.crossedNotes(notes, 13, 14)).toEqual([]);
		// Exclusive lower bound: sitting exactly on a timestamp doesn't re-fire.
		expect(window.YTB.crossedNotes(notes, 10, 11)).toEqual([]);
	});
});

describe('shared playlist client API', () => {
	it('posts a Playlist add with the canonical payload and returns the complete item', async () => {
		storage = { code: 'silly-otters' };
		const item = { videoId: 'v1', title: 'A Great Video', addedBy: 'a1b2c3d4', addedByName: 'Sam', addedAt: 9 };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, item }) });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.postPlaylistAdd({ clientId: 'a1b2c3d4', name: 'Sam', videoId: 'v1', title: 'A Great Video' })).resolves.toEqual({
			ok: true,
			item,
		});
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/playlist?code=silly-otters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ clientId: 'a1b2c3d4', name: 'Sam', videoId: 'v1', title: 'A Great Video' }),
		});
	});

	it('requires a Room Code but ignores the Sharing toggle (curation is not position reporting)', async () => {
		storage = { code: 'silly-otters', sharing: false };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, item: {} }) }));
		await expect(window.YTB.postPlaylistAdd({ clientId: 'a', videoId: 'v', title: 't' })).resolves.toMatchObject({ ok: true });

		storage = {};
		await expect(window.YTB.postPlaylistAdd({ clientId: 'a', videoId: 'v', title: 't' })).resolves.toEqual({
			ok: false,
			category: 'unpaired',
		});
	});

	it('surfaces playlist_full as a machine-readable category', async () => {
		storage = { code: 'silly-otters' };
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'playlist full', category: 'playlist_full' }) }),
		);
		await expect(window.YTB.postPlaylistAdd({ clientId: 'a', videoId: 'v', title: 't' })).resolves.toEqual({
			ok: false,
			category: 'playlist_full',
		});
		expect(window.YTB.MAX_PLAYLIST_ITEMS).toBe(30);
	});

	it('deletes a Playlist Item attributing the acting member', async () => {
		storage = { code: 'silly-otters' };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.deletePlaylistItem({ clientId: 'a1b2c3d4', videoId: 'v1' })).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/playlist?code=silly-otters&clientId=a1b2c3d4&videoId=v1', {
			method: 'DELETE',
		});
	});

	it('includes playlist and events in Room reads', async () => {
		const playlist = [{ videoId: 'v1' }];
		const events = [{ type: 'added', videoId: 'v1' }];
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ progress: [], presence: [], notes: [], replies: [], playlist, events }) }),
		);
		await expect(window.YTB.getRecords('silly-otters')).resolves.toMatchObject({ playlist, events, ok: true });
	});

	it('sends mentions on Notes and Replies only when nonempty (wire format stays stable)', async () => {
		storage = { code: 'silly-otters' };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		vi.stubGlobal('fetch', fetchMock);

		await window.YTB.postNote({ clientId: 'a', videoId: 'v', timestamp: 1, kind: 'text', body: 'hi @Bob', mentions: ['buddy222'] });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).mentions).toEqual(['buddy222']);

		await window.YTB.postReply({ clientId: 'a', noteId: 'n', body: 'x', mentions: [] });
		expect('mentions' in JSON.parse(fetchMock.mock.calls[1][1].body)).toBe(false);
	});
});

describe('room home section helpers', () => {
	const me = 'me111111';
	const roomRead = {
		progress: [
			{ clientId: me, name: 'Aidan', videoId: 'v1', timestamp: 10, duration: 100, updatedAt: 1000 },
			{ clientId: 'bob22222', name: 'Bob', videoId: 'v1', timestamp: 20, duration: 100, updatedAt: 2000 },
			{ clientId: 'ana33333', name: 'Ana', videoId: 'v1', timestamp: 30, duration: 100, updatedAt: 3000 },
			{ clientId: 'cid44444', name: 'Cid', videoId: 'v1', timestamp: 40, duration: 100, updatedAt: 4000 },
			{ clientId: 'bob22222', name: 'Bobby', videoId: 'v2', timestamp: 5, duration: 100, updatedAt: 5000 },
		],
		presence: [{ clientId: 'eve55555', name: '', updatedAt: 6000 }],
		notes: [],
		replies: [],
		playlist: [{ videoId: 'v9', title: 'Queued', addedBy: 'pia66666', addedByName: 'Pia', addedAt: 7000 }],
		events: [{ id: 'e1', type: 'removed', videoId: 'v9', actorClientId: 'ana33333', at: 8000 }],
	};

	it('derives the roster from every record kind, latest nonblank name winning', () => {
		const roster = window.YTB.roomRoster(roomRead);
		const byId = new Map(roster.map((m) => [m.clientId, m.name]));
		// Union across progress + presence + playlist + events.
		expect([...byId.keys()].sort()).toEqual(['ana33333', 'bob22222', 'cid44444', 'eve55555', me, 'pia66666'].sort());
		// Bob renamed to Bobby on his newer record; Ana's nameless Event at 8000
		// must NOT blank her name from the 3000 progress record.
		expect(byId.get('bob22222')).toBe('Bobby');
		expect(byId.get('ana33333')).toBe('Ana');
		expect(byId.get('eve55555')).toBe('');
		// Newest activity first: Ana's Event (8000) outranks Pia's add (7000).
		expect(roster[0].clientId).toBe('ana33333');
	});

	it('fuzzy-searches the roster: prefix, then substring, then subsequence', () => {
		const roster = [
			{ clientId: 'a', name: 'Bob' },
			{ clientId: 'b', name: 'Bobby Tables' },
			{ clientId: 'c', name: 'Ana' },
			{ clientId: 'd', name: '' },
		];
		expect(window.YTB.filterRoster(roster, 'bo').map((m) => m.clientId)).toEqual(['a', 'b']);
		// Prefix outranks substring: "Ana" before "Bobby Tables" (a in "Tables").
		expect(window.YTB.filterRoster(roster, 'a').map((m) => m.clientId)).toEqual(['c', 'b']);
		// In-order subsequence: "bbt" finds Bobby Tables only.
		expect(window.YTB.filterRoster(roster, 'bbt').map((m) => m.clientId)).toEqual(['b']);
		expect(window.YTB.filterRoster(roster, 'zzz')).toEqual([]);
		// Empty query returns the whole roster in roster order.
		expect(window.YTB.filterRoster(roster, '').map((m) => m.clientId)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('resolves a Mention to the current Display Name, falling back to the Buddy token', () => {
		const roster = window.YTB.roomRoster(roomRead);
		expect(window.YTB.mentionName(roster, 'bob22222')).toBe('Bobby');
		// A member who left resolves to the stable "<Adjective> Buddy", never a raw id.
		expect(window.YTB.mentionName(roster, 'gone9999')).toBe(window.YTB.buddyName('gone9999'));
		expect(window.YTB.mentionName(roster, 'eve55555')).toBe(window.YTB.buddyName('eve55555'));
	});

	it('labels watched-by: You first, up to two Buddy names, then a collapsed count', () => {
		const progress = roomRead.progress;
		// You + 3 Buddies: two names (most recent first), remainder collapsed.
		expect(window.YTB.watchedByLabel(progress, 'v1', me)).toBe('You, Cid, Ana, and 1 other');
		// Single foreign watcher: bare name (his latest Display Name).
		expect(window.YTB.watchedByLabel(progress, 'v2', me)).toBe('Bobby');
		// Another viewer's perspective: their own "You" first, then the two most
		// recent foreign names, and the last watcher collapsed.
		expect(window.YTB.watchedByLabel(progress, 'v1', 'cid44444')).toBe('You, Ana, Bob, and 1 other');
		expect(
			window.YTB.watchedByLabel(
				[
					{ clientId: me, videoId: 'v3', updatedAt: 1 },
					{ clientId: 'bob22222', name: 'Bob', videoId: 'v3', updatedAt: 2 },
				],
				'v3',
				me,
			),
		).toBe('You and Bob');
		// Blank-name watcher uses the stable Buddy fallback.
		expect(window.YTB.watchedByLabel([{ clientId: 'eve55555', name: '', videoId: 'v4', updatedAt: 1 }], 'v4', me)).toBe(
			window.YTB.buddyName('eve55555'),
		);
		// Nobody watched: empty label.
		expect(window.YTB.watchedByLabel(progress, 'unwatched', me)).toBe('');
	});

	it('builds the personalized Feed: replies to mine, mentions of me, and System Messages', () => {
		const base = new Date(2026, 6, 4, 12, 0, 0).getTime(); // local noon — no midnight straddle
		const notes = [
			{ id: 'n1', clientId: me, name: 'Aidan', videoId: 'v1', timestamp: 5, kind: 'text', body: 'mine', createdAt: base },
			{ id: 'n2', clientId: 'bob22222', name: 'Bob', videoId: 'v1', timestamp: 6, kind: 'text', body: 'hey @Aidan', mentions: [me], createdAt: base + 1000 },
			{ id: 'n3', clientId: 'bob22222', name: 'Bob', videoId: 'v1', timestamp: 7, kind: 'text', body: 'unrelated', createdAt: base + 1500 },
		];
		const replies = [
			{ id: 'r1', noteId: 'n1', clientId: 'bob22222', name: 'Bob', body: 'reply to yours', createdAt: base + 2000 },
			{ id: 'r2', noteId: 'n1', clientId: me, name: 'Aidan', body: 'my own reply', createdAt: base + 3000 },
			{ id: 'r3', noteId: 'n3', clientId: 'ana33333', name: 'Ana', body: '@Aidan look', mentions: [me], createdAt: base + 4000 },
			{ id: 'r4', noteId: 'n1', clientId: 'ana33333', name: 'Ana', body: 'both', mentions: [me], createdAt: base + 5000 },
			{ id: 'r5', noteId: 'n3', clientId: 'cid44444', name: 'Cid', body: 'not for me', createdAt: base + 6000 },
		];
		const events = [
			{ id: 'e1', type: 'added', videoId: 'v9', actorClientId: 'bob22222', at: base + 7000 },
			{ id: 'e2', type: 'removed', videoId: 'v9', actorClientId: 'ana33333', at: base + 26 * 3600_000 },
		];

		const groups = window.YTB.buildFeed({ notes, replies, events }, me);
		// Two local days -> two divider groups, both ascending.
		expect(groups).toHaveLength(2);
		const first = groups[0].items;
		// My own note (n1), my own reply (r2), the unrelated note (n3), and the
		// not-for-me reply (r5) are all absent. r4 (reply-to-mine AND mention)
		// appears exactly once, as a reply.
		expect(first.map((item) => item.type)).toEqual(['mention', 'reply', 'mention', 'reply', 'system']);
		expect(first.map((item) => item.at)).toEqual([base + 1000, base + 2000, base + 4000, base + 5000, base + 7000]);
		expect(first[1].note.id).toBe('n1'); // a reply item carries its parent Note
		expect(groups[1].items.map((item) => item.type)).toEqual(['system']);
		expect(groups[0].dayKey).not.toBe(groups[1].dayKey);

		// There is NO read/unread state anywhere on the items.
		for (const item of [...first, ...groups[1].items]) {
			expect('read' in item).toBe(false);
			expect('unread' in item).toBe(false);
		}
	});

	it('labels Feed day dividers as Today / Yesterday / short date', () => {
		const now = new Date(2026, 6, 5, 15, 0, 0).getTime();
		const keyOf = (ms: number) => window.YTB.buildFeed({ events: [{ id: 'e', type: 'added', videoId: 'v', actorClientId: 'a', at: ms }] }, 'me')[0].dayKey;
		expect(window.YTB.dayLabel(keyOf(now), now)).toBe('Today');
		expect(window.YTB.dayLabel(keyOf(now - 24 * 3600_000), now)).toBe('Yesterday');
		expect(window.YTB.dayLabel(keyOf(new Date(2026, 6, 3, 12).getTime()), now)).toMatch(/Jul/);
	});
});

describe('extension context lifecycle', () => {
	it('keeps unrelated Chrome API failures observable', async () => {
		const failure = new Error('storage unavailable');
		vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(failure);

		await expect(window.YTB.getConfig()).rejects.toBe(failure);
		expect(window.YTB.isContextActive()).toBe(true);
	});

	it('stops stale work and consumes only extension-context invalidation', async () => {
		const stop = vi.fn();
		window.YTB.onContextInvalidated(stop);
		vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('Extension context invalidated.'));

		await expect(window.YTB.getConfig()).resolves.toEqual({ name: '', code: '', clientId: '', sharing: true });
		expect(stop).toHaveBeenCalledOnce();
		expect(window.YTB.isContextActive()).toBe(false);

		const callsAfterInvalidation = vi.mocked(chrome.storage.local.get).mock.calls.length;
		await expect(window.YTB.getConfig()).resolves.toEqual({ name: '', code: '', clientId: '', sharing: true });
		expect(chrome.storage.local.get).toHaveBeenCalledTimes(callsAfterInvalidation);
	});
});

type WriteResult<K extends string, V> = ({ ok: true } & Record<K, V>) | { ok: false; category: string };

declare global {
	interface Window {
		YTB: {
			getConfig(): Promise<{ name: string; code: string; clientId: string; sharing: boolean }>;
			isContextActive(): boolean;
			onContextInvalidated(callback: () => void): () => void;
			roomExists(records: { progress: object[]; presence: object[] }): boolean;
			deleteMember(code: string, clientId: string): Promise<{ ok: true } | false>;
			deleteNote(code: string, clientId: string, id: string): Promise<{ ok: true } | false>;
			postNote(note: object): Promise<WriteResult<'note', object>>;
			postReply(reply: object): Promise<WriteResult<'reply', object>>;
			getConversation(code: string, noteId: string): Promise<WriteResult<'note', object> & { replies?: object[] }>;
			NOTE_EMOJIS: string[];
			MAX_PLAYLIST_ITEMS: number;
			postPlaylistAdd(item: object): Promise<WriteResult<'item', object>>;
			deletePlaylistItem(target: { clientId: string; videoId: string }): Promise<{ ok: true } | { ok: false; category: string }>;
			buddyName(clientId: string, name?: string): string;
			roomRoster(records: object): Array<{ clientId: string; name: string }>;
			filterRoster(roster: Array<{ clientId: string; name: string }>, query: string): Array<{ clientId: string; name: string }>;
			mentionName(roster: Array<{ clientId: string; name: string }>, clientId: string): string;
			watchedByLabel(progress: object[], videoId: string, myClientId: string): string;
			buildFeed(
				records: object,
				myClientId: string,
			): Array<{ dayKey: string; items: Array<{ type: string; at: number; note?: { id: string } | null; reply?: object; event?: object }> }>;
			dayLabel(dayKey: string, nowMs?: number): string;
			getRecords(code: string): Promise<{ notes: object[]; replies: object[]; playlist?: object[]; events?: object[]; ok: boolean }>;
			syncBuddyColors(code: string, ids: string[], successful: boolean, random?: () => number): Promise<Record<string, string>>;
			setBuddyColor(code: string, clientId: string, color: string): Promise<boolean>;
			clearRoomColors(code: string): Promise<void>;
			relativeTime(thenMs: number, nowMs?: number): string;
			errorCopy(category: string, action: 'note' | 'reply' | 'reaction'): string;
			spreadFractions(dots: Array<{ id: string; timestamp: number; fraction: number }>, minGap?: number): Map<string, number>;
			crossedNotes<T extends { timestamp: number }>(notes: T[], previousTime: number, currentTime: number): T[];
		};
	}
}
