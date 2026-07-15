import { beforeAll, describe, expect, it, vi } from 'vitest';

let storage: Record<string, unknown>;

// The extension exposes its API as classic-script globals on `window` (ADR-0001),
// so `window.YTB`'s methods surface as `any`. These aliases give the values the
// specs read back the concrete shapes the pure helpers actually return, so the
// callbacks below are checked instead of silently `any`.
type RosterEntry = { clientId: string; name: string };
type FeedItem = {
	type: string;
	at: number;
	own: boolean;
	removed: boolean;
	clientId: string;
	name: string;
	videoId: string;
	title: string;
	note: { id: string };
	event: { id: string; videoId: string; title: string; actorClientId: string };
};
type FeedGroup = { dayKey: string; items: FeedItem[] };
type PlaylistRec = { videoId: string };

// `window.YTB.buildFeed` surfaces as `any` (a classic-script global; ADR-0001);
// wrap it once so the Room Feed shape flows into the callbacks that read it back.
const buildFeed = (records: object, viewer: string): FeedGroup[] => window.YTB.buildFeed(records, viewer);
// `window.YTB.tailFeed` likewise: the wrapper pins the reveal window's shape.
const tailFeed = (groups: FeedGroup[], limit: number): { groups: FeedGroup[]; hidden: number } => window.YTB.tailFeed(groups, limit);

// `window.YTB.solveDotFan` likewise (#162). The wrapper also pins the standing
// geometry — a 14px ideal Fan Gap, a 6px dot, a 1000px bar — so each case below
// states only what it varies from it.
type FanSolution = { clusters: number[][]; offsets: number[]; gap: number };
type FanOptions = { idealGap?: number; barWidth?: number; dotDiameter?: number };
const solveFan = (xs: number[], options: FanOptions = {}): FanSolution =>
	window.YTB.solveDotFan(xs, { idealGap: 14, barWidth: 1000, dotDiameter: 6, ...options });
/** Where the solve actually lands each dot's center, float dust rounded off. */
const fanned = (xs: number[], options: FanOptions = {}): number[] =>
	solveFan(xs, options).offsets.map((offset, i) => Number((xs[i] + offset).toFixed(3)));

// Every describe in this file reads `window.YTB`, so the extension globals are
// installed once per FILE rather than inside one describe's beforeAll — that way
// a filtered run (`npx vitest run -t "..."`) of any single test still has them.
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
				// Captures shared.js's load-time subscription (the single buddyColors
				// listener) so specs can drive the callback directly.
				onChanged: {
					addListener: vi.fn(),
				},
			},
		},
	});
	// shared.js is a classic content script (no import/export; ADR-0001), so it is
	// loaded here purely for its side effect of populating window.YTB. The `as
	// string` keeps the literal specifier for the bundler while telling TypeScript
	// to treat it as a dynamic (non-module) import rather than erroring on it.
	await import('../../extension/shared.js' as string);
});

describe('extension member API', () => {
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
			category: 'network',
		});
		await expect(window.YTB.deletePlaylistItem({ clientId: 'a', videoId: 'v' })).resolves.toEqual({
			ok: false,
			category: 'network',
		});

		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => Promise.reject(new SyntaxError('bad json')) }));
		await expect(window.YTB.postReply({ clientId: 'a', noteId: 'n', body: 'x' })).resolves.toEqual({
			ok: false,
			category: 'unexpected',
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => Promise.reject(new SyntaxError('bad json')) }));
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
		expect(window.YTB.errorCopy('network', 'note')).toBe("Can't reach the backend. Check your connection and try again.");
		expect(window.YTB.errorCopy('network', 'recommendation')).toBe("Can't reach the backend. Check your connection and try again.");
		expect(window.YTB.errorCopy('reply_cap', 'reply')).toBe('This note already has 10 replies.');
		expect(window.YTB.errorCopy('room_full', 'note')).toBe("This Room is full, so you can't post here.");
		expect(window.YTB.errorCopy('missing_parent', 'reply')).toBe('This note is no longer available.');
		expect(window.YTB.errorCopy('unexpected', 'note')).toBe("We couldn't post your note. Try again.");
		expect(window.YTB.errorCopy('validation', 'reply')).toBe("We couldn't post your reply. Try again.");
		expect(window.YTB.errorCopy('unexpected', 'reaction')).toBe("We couldn't post your reaction. Try again.");
	});

	it('tracks Connection Lost after exactly two consecutive failed reads', () => {
		expect(window.YTB.connectionState(0, false)).toEqual({ failures: 1, lost: false });
		expect(window.YTB.connectionState(1, false)).toEqual({ failures: 2, lost: true });
		expect(window.YTB.connectionState(2, false)).toEqual({ failures: 3, lost: true });
		expect(window.YTB.connectionState(9, true)).toEqual({ failures: 0, lost: false });
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

	it('routes dot activation to "open" for every Note kind — the click never seeks', () => {
		// Activating ANY dot/preview opens its Expanded Note; the timeline no
		// longer seeks (Go here inside the panel is the only seek). Text Notes,
		// Reactions, and locked or unlocked Spoilers all route the same.
		expect(window.YTB.dotActivation({ kind: 'text', timestamp: 42 })).toEqual({ action: 'open' });
		expect(window.YTB.dotActivation({ kind: 'emoji', timestamp: 42 })).toEqual({ action: 'open' });
		expect(window.YTB.dotActivation({ kind: 'text', spoiler: true, timestamp: 42 })).toEqual({ action: 'open' });
	});

	it('chooses the Expanded Note variant from the panel-open playhead', () => {
		// A Spoiler whose moment is still ahead of the playhead opens masked.
		expect(window.YTB.notePanelVariant({ kind: 'text', spoiler: true, timestamp: 42 }, 5)).toBe('spoiler');
		// Once the playhead reaches/passes it, the Spoiler is a normal text panel.
		expect(window.YTB.notePanelVariant({ kind: 'text', spoiler: true, timestamp: 42 }, 42)).toBe('text');
		expect(window.YTB.notePanelVariant({ kind: 'text', spoiler: true, timestamp: 42 }, 90)).toBe('text');
		// A Reaction is always the read-only reaction panel (never a Spoiler).
		expect(window.YTB.notePanelVariant({ kind: 'emoji', timestamp: 42 }, 5)).toBe('reaction');
		expect(window.YTB.notePanelVariant({ kind: 'emoji', timestamp: 42 }, 90)).toBe('reaction');
		// A plain text Note is always the text panel.
		expect(window.YTB.notePanelVariant({ kind: 'text', timestamp: 42 }, 5)).toBe('text');
		// No player (Infinity): nothing locks, so a Spoiler opens as text.
		expect(window.YTB.notePanelVariant({ kind: 'text', spoiler: true, timestamp: 42 }, Infinity)).toBe('text');
		expect(window.YTB.notePanelVariant({ kind: 'emoji', timestamp: 42 }, Infinity)).toBe('reaction');
	});

	it('hides Go here only when the playhead sits within 2s of the moment', () => {
		// Within the 2s window (inclusive of the boundary) there is nowhere to go.
		expect(window.YTB.nearNoteMoment(42, 42)).toBe(true);
		expect(window.YTB.nearNoteMoment(42, 40)).toBe(true);
		expect(window.YTB.nearNoteMoment(42, 44)).toBe(true);
		// Just outside the window Go here shows again.
		expect(window.YTB.nearNoteMoment(42, 39.9)).toBe(false);
		expect(window.YTB.nearNoteMoment(42, 44.1)).toBe(false);
		// No player (non-finite playhead) is never near, so Go here shows.
		expect(window.YTB.nearNoteMoment(42, Infinity)).toBe(false);
		expect(window.YTB.nearNoteMoment(42, Number.NaN)).toBe(false);
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

	it('maps a timestamp to x through the bar chapter geometry, never into a gap', () => {
		const x = (segments: Array<{ left: number; width: number }>, t: number, d: number): number => window.YTB.timeToX(segments, t, d);
		// UNCHAPTERED: one full-width segment is exactly `fraction * barWidth`, so
		// chapter awareness is a no-op there by construction.
		const plain = [{ left: 0, width: 1000 }];
		expect(x(plain, 0, 200)).toBe(0);
		expect(x(plain, 50, 200)).toBe(250);
		expect(x(plain, 200, 200)).toBe(1000);

		// CHAPTERED, as YouTube draws it: three segments whose widths are
		// proportional to their chapters' durations, separated by 4px gaps. The bar
		// is still 1000px wide, but only 992px of it is segment (two gaps), and the
		// 100s video's time is shared out over that 992px — never over the 1000px.
		const segs = [
			{ left: 0, width: 496 }, // first half of the video: 0s -> 50s
			{ left: 500, width: 248 }, // 50s -> 75s
			{ left: 752, width: 248 }, // 75s -> 100s
		];
		// t = 0 and t = duration pin to the outer edges of the outer segments.
		expect(x(segs, 0, 100)).toBe(0);
		expect(x(segs, 100, 100)).toBe(1000);
		// Inside a segment: linear within that segment, NOT across the whole bar.
		// 25s is halfway through chapter 1 -> 248px, where the uniform mapping would
		// wrongly say 250px.
		expect(x(segs, 25, 100)).toBeCloseTo(248, 6);
		// The 50s boundary sits at the END of the earlier chapter (496), not at the
		// start of the next one (500): the walk consumes segment width only.
		expect(x(segs, 50, 100)).toBeCloseTo(496, 6);
		// Past the boundary, x picks up the gap the uniform mapping ignores: 62.5s is
		// halfway through chapter 2 -> 500 + 124 = 624, while `fraction * barWidth`
		// would say 625.
		expect(x(segs, 62.5, 100)).toBeCloseTo(624, 6);
		// A timestamp whose UNIFORM x would land inside the 4px gap (498px) never
		// lands in a gap here: 49.8s maps into chapter 1, at 494.
		expect(x(segs, 49.8, 100)).toBeCloseTo(494.016, 3);
		// Out-of-range timestamps clamp to the bar's ends.
		expect(x(segs, -10, 100)).toBe(0);
		expect(x(segs, 500, 100)).toBe(1000);
		// Degenerate inputs: no segments (the bar is not laid out yet) and a
		// nonsense duration both resolve to the bar's left edge rather than NaN.
		expect(x([], 30, 100)).toBe(0);
		expect(x(segs, 30, 0)).toBe(0);
		expect(x(segs, Number.NaN, 100)).toBe(0);
	});

	it('solves the Dot Cluster fan by minimum displacement, chaining what it touches', () => {
		// A dot with room to breathe does not move; a Cluster is exactly what the
		// separation constraint chains together (#162).
		// A lone dot is a Cluster of one and never moves — not even one hanging off
		// the bar's left edge at rest: the bar's edges exist to keep a FAN on the
		// bar, and there is no fan here to keep.
		expect(solveFan([500])).toEqual({ clusters: [[0]], offsets: [0], gap: 14 });
		expect(solveFan([1]).offsets).toEqual([0]);
		// Two dots a comfortable distance apart: neither moves, and each is its own
		// Cluster (the constraint chains nothing).
		expect(solveFan([200, 500])).toEqual({ clusters: [[0], [1]], offsets: [0, 0], gap: 14 });

		// A co-timed pair separates symmetrically about its own centre — the minimum
		// displacement that opens the Fan Gap between them. Offsets come back in
		// INPUT order while the Cluster is ordered left to right, so the later-listed
		// earlier dot leads the group and still takes the left half of the fan.
		expect(solveFan([500, 500])).toEqual({ clusters: [[0, 1]], offsets: [-7, 7], gap: 14 });
		// A near-timed pair (5px apart) opens the Fan Gap between them by moving each
		// 4.5px — half the shortfall apiece, which is the least either can move.
		expect(solveFan([505, 500])).toEqual({ clusters: [[1, 0]], offsets: [4.5, -4.5], gap: 14 });

		// THE OVERLAP BUG (#162, 1): the old rank fan spread a co-timed pair by 14px
		// about its centroid and left a dot 10px away at rest — landing the fanned
		// dot 3px from it, re-creating the overlap the fan exists to resolve. The
		// constraint is global now, so that third dot is chained IN and the solve
		// separates all three: no dot is ever "outside" the fan.
		const chained = solveFan([500, 500, 510]);
		expect(chained.clusters).toEqual([[0, 1, 2]]);
		expect(chained.offsets.map((o: number) => Number(o.toFixed(3)))).toEqual([-10.667, 3.333, 7.333]);
		// Every separation is exactly the Fan Gap: minimum displacement, no cover.
		expect(fanned([500, 500, 510])).toEqual([489.333, 503.333, 517.333]);

		// THE EVEN-SPACING LIE (#162, 2): true spacing survives wherever the Fan Gap
		// allows. A dot 30px clear of a co-timed pair keeps its distance instead of
		// being re-slotted 14px beside them — it does not move at all, and it stays
		// its own Cluster.
		const roomy = solveFan([500, 500, 530]);
		expect(roomy.clusters).toEqual([[0, 1], [2]]);
		expect(roomy.offsets).toEqual([-7, 7, 0]);

		// Degenerate input.
		expect(solveFan([])).toEqual({ clusters: [], offsets: [], gap: 14 });
	});

	it('holds the Dot Cluster fan on the bar, shrinking the Fan Gap toward the dot diameter', () => {
		// Edge clamp: a co-timed pair hard against the right edge slides left as one
		// so no circle (radius 3) is pushed past 1000. Unclamped the fan would sit at
		// [991, 1005]; the solve holds the rightmost centre at 997 = 1000 - radius.
		expect(fanned([998, 998])).toEqual([983, 997]);
		expect(solveFan([998, 998]).offsets).toEqual([-15, -1]);
		// The left edge mirrors it: the leftmost circle lands exactly on radius.
		expect(fanned([2, 2])).toEqual([3, 17]);

		// A crowded bar shrinks the Fan Gap rather than running off the end: ten
		// co-timed dots on a 100px bar cannot hold the 14px ideal (9 gaps * 14 =
		// 126 > 94px of room), so the gap opens only as far as the bar allows and the
		// fan spans it exactly, edge circle to edge circle.
		const crowded = solveFan(
			Array.from({ length: 10 }, () => 50),
			{ barWidth: 100 },
		);
		expect(crowded.gap).toBeCloseTo(94 / 9, 6); // ~10.44px, under the 14px ideal
		const spread = fanned(
			Array.from({ length: 10 }, () => 50),
			{ barWidth: 100 },
		);
		expect(spread[0]).toBeCloseTo(3, 6); // the left circle sits on the bar's edge
		expect(spread[9]).toBeCloseTo(97, 6); // and the right circle on the other
		expect(crowded.clusters).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);

		// The Fan Gap floors at one dot diameter: fanned dots may TOUCH, never cover.
		// Ten dots on a 30px bar cannot even be laid out 6px apart, so separation
		// wins over containment (a fan that covers its own dots is not an affordance)
		// and the chain keeps its floor gap, centred on the bar.
		const floored = fanned(
			Array.from({ length: 10 }, () => 15),
			{ barWidth: 30 },
		);
		expect(
			solveFan(
				Array.from({ length: 10 }, () => 15),
				{ barWidth: 30 },
			).gap,
		).toBe(6);
		for (let i = 1; i < floored.length; i++) expect(floored[i] - floored[i - 1]).toBeCloseTo(6, 6);
		expect((floored[0] + floored[9]) / 2).toBeCloseTo(15, 6); // centred on the bar

		// An unmeasured bar (the player has not laid out the progress bar yet) imposes
		// no edge at all: the fan still separates at the ideal gap.
		expect(fanned([500, 500], { barWidth: 0 })).toEqual([493, 507]);
	});

	it('never lets a fanned Note Dot overlap another dot, over randomized bars', () => {
		// The property the whole solve exists for (#162), over generated layouts
		// rather than fixed cases: fan ANY one Cluster and every other dot on the bar
		// stays where it is — no fanned dot may come within the Fan Gap of a fellow
		// member OR of a dot at rest elsewhere. Deterministic PRNG (mulberry32) so a
		// failure is reproducible.
		let seed = 0x9e3779b9;
		const random = () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const DIAMETER = 6;
		const EPS = 1e-6;

		for (let trial = 0; trial < 300; trial++) {
			const barWidth = [180, 420, 640, 1280][Math.floor(random() * 4)];
			const count = 1 + Math.floor(random() * 24);
			// Dots land anywhere on the bar, in clumps as tight as co-timed Notes and
			// as loose as a sparse timeline — and a few just off each end, where the
			// edge clamp bites.
			const xs = Array.from({ length: count }, () => {
				const clump = random() < 0.5 ? Math.round(random() * barWidth) : Math.round(random() * barWidth * 0.1);
				return clump + Math.round((random() - 0.5) * 12);
			});
			const { clusters, offsets, gap } = window.YTB.solveDotFan(xs, {
				idealGap: 14,
				barWidth,
				dotDiameter: DIAMETER,
			});
			const layout = { xs, barWidth, gap, clusters, offsets };

			// Structural: the clusters partition every dot, exactly once.
			expect(
				clusters
					.flat()
					.slice()
					.sort((a: number, b: number) => a - b),
			).toEqual(xs.map((_, i) => i));
			// The Fan Gap never floors below the dot diameter — touching, never covering.
			expect(gap).toBeGreaterThanOrEqual(DIAMETER - EPS);
			expect(gap).toBeLessThanOrEqual(14 + EPS);

			for (const cluster of clusters) {
				// Hovering THIS Cluster fans its members; every other dot on the bar
				// stays at its exact at-rest position.
				const member = new Set<number>(cluster);
				const rendered = xs.map((x, i) => (member.has(i) ? x + offsets[i] : x));
				const where = (i: number, j: number) => `${JSON.stringify(layout)} dots ${i},${j}`;
				for (const i of cluster) {
					for (let j = 0; j < xs.length; j++) {
						// A pair at rest OUTSIDE the fanned Cluster may of course still
						// overlap — dots tell the truth about their moments at rest. The
						// claim is only about the dots the fan MOVES: against each other,
						// and against every dot left standing elsewhere on the bar.
						if (i === j || (member.has(j) && j < i)) continue;
						expect(Math.abs(rendered[i] - rendered[j]), where(i, j)).toBeGreaterThanOrEqual(gap - EPS);
					}
				}
				// A lone dot never moves; a fanned Cluster never runs off a bar with
				// the room to hold it.
				if (cluster.length === 1) expect(offsets[cluster[0]], JSON.stringify(layout)).toBe(0);
				else if ((xs.length - 1) * gap <= barWidth - DIAMETER + EPS) {
					for (const i of cluster) {
						expect(rendered[i], JSON.stringify(layout)).toBeGreaterThanOrEqual(DIAMETER / 2 - EPS);
						expect(rendered[i], JSON.stringify(layout)).toBeLessThanOrEqual(barWidth - DIAMETER / 2 + EPS);
					}
				}
			}
		}
	});

	it('routes a video play: the arrival grace holds, later plays dismiss an open panel', () => {
		// Inside the arrival grace (a Room Feed row paused us on arrival): autoplay
		// settling in must re-pause, whatever else is on screen (ADR-0010).
		expect(window.YTB.playAction({ withinGrace: true, panelOpen: false })).toBe('hold');
		expect(window.YTB.playAction({ withinGrace: true, panelOpen: true })).toBe('hold');
		// Past the grace, with an Expanded Note open: a deliberate resume dismisses it.
		expect(window.YTB.playAction({ withinGrace: false, panelOpen: true })).toBe('dismiss');
		// Past the grace, no panel: a play is nothing to do with us.
		expect(window.YTB.playAction({ withinGrace: false, panelOpen: false })).toBe('ignore');
	});

	it('routes overlay clicks by Picture, player chrome, and off-player Pause Hold', () => {
		const route = (state: {
			overlayOpen?: boolean;
			region?: 'picture' | 'chrome' | 'outside';
			pauseHold?: boolean;
			withinGrace?: boolean;
		}) =>
			window.YTB.pictureClickAction({
				overlayOpen: true,
				region: 'outside',
				pauseHold: false,
				withinGrace: false,
				...state,
			});

		// The normal watching path is untouched, even on the Video Picture.
		expect(route({ overlayOpen: false, region: 'picture', pauseHold: true, withinGrace: true })).toEqual({
			close: false,
			consume: false,
			play: false,
			cancelArrivalGrace: false,
		});

		// A Picture Click always plays, regardless of the Pause Hold. Inside the
		// arrival grace it also cancels that hold before play is requested.
		expect(route({ region: 'picture', pauseHold: false, withinGrace: false })).toEqual({
			close: true,
			consume: true,
			play: true,
			cancelArrivalGrace: false,
		});
		expect(route({ region: 'picture', pauseHold: true, withinGrace: true })).toEqual({
			close: true,
			consume: true,
			play: true,
			cancelArrivalGrace: true,
		});

		// Player controls keep the click and own playback, with or without a hold.
		expect(route({ region: 'chrome', pauseHold: false, withinGrace: false })).toEqual({
			close: true,
			consume: false,
			play: false,
			cancelArrivalGrace: false,
		});
		expect(route({ region: 'chrome', pauseHold: true, withinGrace: true })).toEqual({
			close: true,
			consume: false,
			play: false,
			cancelArrivalGrace: false,
		});

		// Off-player dismissal restores only the state represented by a Pause Hold.
		expect(route({ region: 'outside', pauseHold: false, withinGrace: false }).play).toBe(false);
		expect(route({ region: 'outside', pauseHold: true, withinGrace: false }).play).toBe(true);
	});

	it('classifies player surface clicks without treating controls as the Video Picture', () => {
		const offPlayer = { closest: vi.fn().mockReturnValue(null) };
		const picture = { closest: vi.fn().mockReturnValueOnce({}).mockReturnValueOnce(null) };
		const chrome = { closest: vi.fn().mockReturnValue({}) };

		expect(window.YTB.pictureClickRegion(offPlayer)).toBe('outside');
		expect(window.YTB.pictureClickRegion(picture)).toBe('picture');
		expect(window.YTB.pictureClickRegion(chrome)).toBe('chrome');
	});
});

describe('own churn + Watched-By ownership (#174)', () => {
	// `window.YTB.ytbOwnedChurn` / `previewOwnsTile` surface as `any` (classic-
	// script globals; ADR-0001); the wrappers pin the boolean the specs assert.
	const ytbOwnedChurn = (records: object[]): boolean => window.YTB.ytbOwnedChurn(records);
	const previewOwnsTile = (preview: object | null, tile: object | null): boolean => window.YTB.previewOwnsTile(preview, tile);

	// Duck-typed DOM: shared.js walks only nodeType/id/classList/parentNode.
	type MockNode = { nodeType: number; id?: string; classList?: string[]; parentNode?: MockNode | null };
	const el = (classList: string[] = [], id = '', parentNode: MockNode | null = null): MockNode => ({
		nodeType: 1,
		id,
		classList,
		parentNode,
	});
	const text = (parentNode: MockNode | null = null): MockNode => ({ nodeType: 3, parentNode });
	const record = (target: MockNode, addedNodes: MockNode[] = [], removedNodes: MockNode[] = []) => ({
		target,
		addedNodes,
		removedNodes,
	});
	const ytTile = () => el(['ytd-rich-item-renderer']);

	it('owns mounting and unmounting YTB roots in YouTube DOM, by class or id prefix', () => {
		expect(ytbOwnedChurn([record(ytTile(), [el(['ytb-thumb-dots'])])])).toBe(true);
		expect(ytbOwnedChurn([record(ytTile(), [], [el(['ytb-thumb-dots'])])])).toBe(true);
		expect(ytbOwnedChurn([record(ytTile(), [el([], 'ytb-home-section')])])).toBe(true);
	});

	it('owns churn whose target sits inside a YTB element (tooltip text, dots in a cluster)', () => {
		const tooltip = el(['ytb-watch-tooltip'], '', el(['ytb-thumb-dots'], '', ytTile()));
		expect(ytbOwnedChurn([record(tooltip, [text(tooltip)], [text()])])).toBe(true);

		// An added node with no marker of its own is owned through its ancestors.
		const cluster = el(['ytb-thumb-dots'], '', ytTile());
		expect(ytbOwnedChurn([record(cluster, [el([], '', cluster)])])).toBe(true);
	});

	it("never owns YouTube's churn, a mixed batch, an empty batch, or a record moving nothing", () => {
		expect(ytbOwnedChurn([record(ytTile(), [el(['style-scope'])])])).toBe(false);
		expect(ytbOwnedChurn([record(ytTile(), [el(['ytb-thumb-dots'])]), record(ytTile(), [el(['style-scope'])])])).toBe(false);
		expect(ytbOwnedChurn([])).toBe(false);
		expect(ytbOwnedChurn([record(ytTile())])).toBe(false);
		// A detached unmarked node (a text node whose old parent is gone) is
		// ambiguous — the failure mode must be a redundant pass, not a missed one.
		expect(ytbOwnedChurn([record(ytTile(), [], [text()])])).toBe(false);
	});

	it('pairs the preview to the tile it covers, and never to a neighbour clipping its overhang', () => {
		// The measured live geometry (issue #174): a 524x304 host centred over a
		// 360x202 thumbnail box — full cover.
		const host = { left: 0, top: 0, right: 524, bottom: 304 };
		expect(previewOwnsTile(host, { left: 82, top: 51, right: 442, bottom: 253 })).toBe(true);
		// The next tile over intersects only the host's ~82px overhang: under
		// half its own area, so it keeps its own dots.
		expect(previewOwnsTile(host, { left: 458, top: 51, right: 818, bottom: 253 })).toBe(false);
		expect(previewOwnsTile(host, { left: 600, top: 400, right: 960, bottom: 602 })).toBe(false);
	});

	it('takes exactly half coverage, and rejects degenerate rects', () => {
		const host = { left: 0, top: 0, right: 100, bottom: 100 };
		expect(previewOwnsTile(host, { left: 50, top: 0, right: 150, bottom: 100 })).toBe(true);
		expect(previewOwnsTile(host, { left: 51, top: 0, right: 151, bottom: 100 })).toBe(false);
		expect(previewOwnsTile(host, { left: 40, top: 40, right: 40, bottom: 40 })).toBe(false);
		expect(previewOwnsTile(null, { left: 0, top: 0, right: 10, bottom: 10 })).toBe(false);
		expect(previewOwnsTile(host, null)).toBe(false);
	});
});

describe('shared playlist client API', () => {
	it('posts a Playlist add with the canonical payload and returns the complete item', async () => {
		storage = { code: 'silly-otters' };
		const item = { videoId: 'v1', title: 'A Great Video', addedBy: 'a1b2c3d4', addedByName: 'Sam', addedAt: 9 };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, item }) });
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.postPlaylistAdd({ clientId: 'a1b2c3d4', name: 'Sam', videoId: 'v1', title: 'A Great Video' })).resolves.toEqual(
			{
				ok: true,
				item,
			},
		);
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

	it('sends a Note videoTitle only when the page offered one', async () => {
		storage = { code: 'silly-otters' };
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		vi.stubGlobal('fetch', fetchMock);
		const note = { clientId: 'a', videoId: 'v', timestamp: 1, kind: 'text', body: 'x' };

		await window.YTB.postNote({ ...note, videoTitle: 'Never Gonna Give You Up' });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).videoTitle).toBe('Never Gonna Give You Up');

		await window.YTB.postNote({ ...note, videoTitle: '' });
		expect('videoTitle' in JSON.parse(fetchMock.mock.calls[1][1].body)).toBe(false);

		await window.YTB.postNote(note);
		expect('videoTitle' in JSON.parse(fetchMock.mock.calls[2][1].body)).toBe(false);
	});
});

// The one place that reads the watch page's title, shared by the Note Composer
// and both Recommendation entry points. `doc` is injected, so the selector and
// its fallback are testable without a DOM.
describe('watchTitle', () => {
	const fakeDoc = (heading: string | null, title: string) => ({
		querySelector: (selector: string) => (selector === 'ytd-watch-metadata h1' && heading !== null ? { textContent: heading } : null),
		title,
	});

	it('prefers the metadata heading, trimmed', () => {
		expect(window.YTB.watchTitle(fakeDoc('  Real Title \n', 'Real Title - YouTube'))).toBe('Real Title');
	});

	it('falls back to the tab title without the YouTube suffix', () => {
		expect(window.YTB.watchTitle(fakeDoc(null, 'Fallback Title - YouTube'))).toBe('Fallback Title');
		expect(window.YTB.watchTitle(fakeDoc('   ', 'Fallback Title - YouTube'))).toBe('Fallback Title');
	});

	it('returns an empty string when the page offers no title at all', () => {
		expect(window.YTB.watchTitle(fakeDoc(null, ''))).toBe('');
	});
});

// The Room Feed's "on \"Title\"" fragment. A Note with no captured title names
// no video — never a placeholder like "a video".
describe('videoContext', () => {
	it("quotes the Note's captured title", () => {
		expect(window.YTB.videoContext({ videoTitle: 'Never Gonna Give You Up' })).toBe('on "Never Gonna Give You Up"');
		expect(window.YTB.videoContext({ videoTitle: '  Padded  ' })).toBe('on "Padded"');
	});

	it('yields nothing without a usable title', () => {
		expect(window.YTB.videoContext(null)).toBe('');
		expect(window.YTB.videoContext({})).toBe('');
		expect(window.YTB.videoContext({ videoTitle: '' })).toBe('');
		expect(window.YTB.videoContext({ videoTitle: '   ' })).toBe('');
	});
});

// The Room Feed's link tooltip — for both the System Message / Watch Notice title
// link and a Note/Reply row's quoted body, which now navigates to the video (no
// seek, ADR-0010). Names the destination the row's visible text leaves implicit.
describe('titleLinkTooltip', () => {
	it('quotes the title', () => {
		expect(window.YTB.titleLinkTooltip('Blade Runner')).toBe('Watch "Blade Runner"');
		expect(window.YTB.titleLinkTooltip('  Padded  ')).toBe('Watch "Padded"');
	});

	it('falls back when the row has no title', () => {
		expect(window.YTB.titleLinkTooltip('')).toBe('Watch this video');
		expect(window.YTB.titleLinkTooltip('   ')).toBe('Watch this video');
		expect(window.YTB.titleLinkTooltip(null)).toBe('Watch this video');
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
		const roster: RosterEntry[] = window.YTB.roomRoster(roomRead);
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
		expect(window.YTB.filterRoster(roster, 'bo').map((m: RosterEntry) => m.clientId)).toEqual(['a', 'b']);
		// Prefix outranks substring: "Ana" before "Bobby Tables" (a in "Tables").
		expect(window.YTB.filterRoster(roster, 'a').map((m: RosterEntry) => m.clientId)).toEqual(['c', 'b']);
		// In-order subsequence: "bbt" finds Bobby Tables only.
		expect(window.YTB.filterRoster(roster, 'bbt').map((m: RosterEntry) => m.clientId)).toEqual(['b']);
		expect(window.YTB.filterRoster(roster, 'zzz')).toEqual([]);
		// Empty query returns the whole roster in roster order.
		expect(window.YTB.filterRoster(roster, '').map((m: RosterEntry) => m.clientId)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('disambiguates duplicate labels within a Room by prefixing "Very "', () => {
		// Same typed name: ordered by Client ID, the first stays bare and each
		// later duplicate gains one more "Very ". Distinct names are untouched.
		const roster = [
			{ clientId: 'c', name: 'Sam' },
			{ clientId: 'a', name: 'Sam' },
			{ clientId: 'b', name: 'Sam' },
			{ clientId: 'd', name: 'Solo' },
		];
		const labels = window.YTB.disambiguateNames(roster);
		expect(labels.get('a')).toBe('Sam');
		expect(labels.get('b')).toBe('Very Sam');
		expect(labels.get('c')).toBe('Very Very Sam');
		expect(labels.get('d')).toBe('Solo');
		// buddyName routes through the same map when handed a roster; without one
		// it returns the (possibly-colliding) base label.
		expect(window.YTB.buddyName('c', 'Sam', roster)).toBe('Very Very Sam');
		expect(window.YTB.buddyName('c', 'Sam')).toBe('Sam');
	});

	it('disambiguates unnamed Buddies that hash to the same adjective', () => {
		// Two blank-named members whose Client IDs collide on the same adjective:
		// exactly one keeps the bare "<Adjective> Buddy"; the other reads "Very ".
		const adjs = window.YTB.ADJECTIVES;
		const adjOf = (id: string) => adjs[((window.YTB.hashClientId(id) % adjs.length) + adjs.length) % adjs.length];
		let a = '';
		let b = '';
		for (let i = 0; i < 5000 && !b; i++) {
			const id = 'u' + i;
			if (!a) a = id;
			else if (adjOf(id) === adjOf(a)) b = id;
		}
		expect(b).not.toBe(''); // a collision exists within the search budget
		const roster = [
			{ clientId: a, name: '' },
			{ clientId: b, name: '' },
		];
		const labels = [window.YTB.buddyName(a, '', roster), window.YTB.buddyName(b, '', roster)];
		const base = `${adjOf(a)} Buddy`;
		expect(labels.filter((l) => l === base)).toHaveLength(1);
		expect(labels.filter((l) => l === 'Very ' + base)).toHaveLength(1);
	});

	it('fuzzy-search matches the disambiguated label, not the colliding base', () => {
		const roster = [
			{ clientId: 'a', name: 'Sam' },
			{ clientId: 'b', name: 'Sam' },
		];
		// "b" reads "Very Sam"; a "very" query finds it and not the bare "a".
		expect(window.YTB.filterRoster(roster, 'very').map((m: RosterEntry) => m.clientId)).toEqual(['b']);
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

	it('labels watched-by Buddies-only (the Watched-By Dots tooltip): no "You", same order and collapse', () => {
		const progress = roomRead.progress;
		const buddiesOnly = { buddiesOnly: true };
		// The viewer's own record is dropped WITHOUT a "You" entry; the Buddy
		// ordering (most recent first) and the two-name collapse are unchanged.
		expect(window.YTB.watchedByLabel(progress, 'v1', me, undefined, buddiesOnly)).toBe('Cid, Ana, and 1 other');
		// Another viewer's perspective: their own record excluded the same way.
		expect(window.YTB.watchedByLabel(progress, 'v1', 'cid44444', undefined, buddiesOnly)).toBe('Ana, Bob, and 1 other');
		expect(window.YTB.watchedByLabel(progress, 'v1', 'bob22222', undefined, buddiesOnly)).toBe('Cid, Ana, and 1 other');
		// Exactly two Buddies: plain "A and B", no collapse.
		expect(
			window.YTB.watchedByLabel(
				[
					{ clientId: me, videoId: 'v3', updatedAt: 3 },
					{ clientId: 'bob22222', name: 'Bob', videoId: 'v3', updatedAt: 2 },
					{ clientId: 'ana33333', name: 'Ana', videoId: 'v3', updatedAt: 1 },
				],
				'v3',
				me,
				undefined,
				buddiesOnly,
			),
		).toBe('Bob and Ana');
		// A single Buddy watcher: bare name.
		expect(window.YTB.watchedByLabel(progress, 'v2', me, undefined, buddiesOnly)).toBe('Bobby');
		// Only the viewer watched: empty — a video only you watched shows no dots.
		expect(window.YTB.watchedByLabel([{ clientId: me, videoId: 'v5', updatedAt: 1 }], 'v5', me, undefined, buddiesOnly)).toBe('');
		// Nobody watched: empty label.
		expect(window.YTB.watchedByLabel(progress, 'unwatched', me, undefined, buddiesOnly)).toBe('');
	});

	it('builds the personalized Feed: replies to mine, mentions of me, and System Messages', () => {
		const base = new Date(2026, 6, 4, 12, 0, 0).getTime(); // local noon — no midnight straddle
		const notes = [
			{ id: 'n1', clientId: me, name: 'Aidan', videoId: 'v1', timestamp: 5, kind: 'text', body: 'mine', createdAt: base },
			{
				id: 'n2',
				clientId: 'bob22222',
				name: 'Bob',
				videoId: 'v1',
				timestamp: 6,
				kind: 'text',
				body: 'hey @Aidan',
				mentions: [me],
				createdAt: base + 1000,
			},
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
			{ id: 'e1', type: 'added', videoId: 'v9', title: 'Cats', actorClientId: 'bob22222', at: base + 7000 },
			// My own recommendation — since the ADR-0007 amendment the recommender
			// sees their own line too, flagged `own` for the "You recommended" copy.
			{ id: 'e3', type: 'added', videoId: 'v7', title: 'Mine', actorClientId: me, at: base + 6500 },
			{ id: 'e2', type: 'added', videoId: 'v8', title: 'Dogs', actorClientId: 'ana33333', at: base + 26 * 3600_000 },
		];

		const groups: FeedGroup[] = buildFeed({ notes, replies, events }, me);
		// Two local days -> two divider groups, both ascending.
		expect(groups).toHaveLength(2);
		const first = groups[0].items;
		// My own note (n1), my own reply (r2), the unrelated note (n3), and the
		// not-for-me reply (r5) are all absent. r4 (reply-to-mine AND mention)
		// appears exactly once, as a reply. Recommend events all surface — my own
		// (e3) included — in timestamp order.
		expect(first.map((item) => item.type)).toEqual(['mention', 'reply', 'mention', 'reply', 'system', 'system']);
		expect(first.map((item) => item.at)).toEqual([base + 1000, base + 2000, base + 4000, base + 5000, base + 6500, base + 7000]);
		expect(first[1].note.id).toBe('n1'); // a reply item carries its parent Note
		expect(first[4].event.actorClientId).toBe(me); // my own recommend line...
		expect(first[4].own).toBe(true); // ...marked own for "You recommended" copy
		expect(first[5].event.actorClientId).toBe('bob22222'); // a recipient's recommend message
		expect(first[5].own).toBe(false);
		expect(groups[1].items.map((item) => item.type)).toEqual(['system']);
		expect(groups[0].dayKey).not.toBe(groups[1].dayKey);

		// There is NO read/unread state anywhere on the items.
		for (const item of [...first, ...groups[1].items]) {
			expect('read' in item).toBe(false);
			expect('unread' in item).toBe(false);
		}
	});

	it('recommend System Messages reach every member, own-flagged, added-only, with the stored title', () => {
		const at = new Date(2026, 6, 4, 12).getTime();
		const events = [
			{ id: 'e1', type: 'added', videoId: 'v9', title: 'Otters 101', actorClientId: 'bob22222', at },
			{ id: 'e2', type: 'added', videoId: 'v8', title: 'My Pick', actorClientId: me, at: at + 1000 },
			// A stale un-recommend shape must never render as a recommendation.
			{ id: 'e3', type: 'removed', videoId: 'v7', title: 'Old', actorClientId: 'ana33333', at: at + 2000 },
		];

		// I see Bob's recommend as a recipient line AND my own as an own line
		// (ADR-0007 amendment), both with the stored title (survives an
		// un-recommend since it's captured on the event).
		const mine: FeedItem[] = buildFeed({ events }, me)[0].items;
		expect(mine).toHaveLength(2);
		expect(mine.every((i) => i.type === 'system')).toBe(true);
		expect(mine[0].event.title).toBe('Otters 101');
		expect(mine[0].own).toBe(false);
		expect(mine[1].event.actorClientId).toBe(me);
		expect(mine[1].own).toBe(true);

		// The recommender (bob22222) sees his own recommendation, own-flagged.
		const bobSystems = buildFeed({ events }, 'bob22222')
			.flatMap((g) => g.items)
			.filter((i) => i.type === 'system');
		expect(bobSystems.map((i) => [i.event.id, i.own])).toEqual([
			['e1', true],
			['e2', false],
		]);
		// And the removed-type event surfaces for nobody.
		for (const viewer of [me, 'bob22222', 'ana33333', 'cid44444']) {
			const systems = buildFeed({ events }, viewer)
				.flatMap((g) => g.items)
				.filter((i) => i.type === 'system');
			expect(systems.some((i) => i.event.videoId === 'v7')).toBe(false);
		}
	});

	it('strikes System Messages per Event: superseded or un-recommended lines are removed', () => {
		const at = new Date(2026, 6, 4, 12).getTime();
		const events = [
			{ id: 'e1', type: 'added', videoId: 'v1', title: 'Still Here', actorClientId: 'bob22222', at },
			{ id: 'e2', type: 'added', videoId: 'v2', title: 'Taken Back', actorClientId: me, at: at + 1000 },
		];
		// Only v1 is still in the Room's live Recommendation list — v2 was
		// un-recommended (removals emit NO event; ADR-0007).
		const playlist = [{ videoId: 'v1', title: 'Still Here', addedBy: 'bob22222', addedByName: 'Bob', addedAt: at }];

		const items: FeedItem[] = buildFeed({ events, playlist }, me)[0].items;
		expect(items).toHaveLength(2);
		const live = items.find((i) => i.event.videoId === 'v1')!;
		const gone = items.find((i) => i.event.videoId === 'v2')!;
		expect(live.removed).toBe(false); // a live recommendation is never struck
		expect(gone.removed).toBe(true); // an un-recommended videoId's sole Event is struck
		// The struck line keeps its real title, captured on the event.
		expect(gone.event.title).toBe('Taken Back');
		// The recipient derives the same strike from the same read.
		const bobsGone = buildFeed({ events, playlist }, 'bob22222')
			.flatMap((g) => g.items)
			.find((i) => i.type === 'system' && i.event.videoId === 'v2')!;
		expect(bobsGone.removed).toBe(true);

		// Re-recommending v2 (a fresh event + the videoId live again) revives
		// ONLY the newest line. The older Event was superseded and stays struck —
		// removal is per EVENT, so recommend -> un-recommend -> re-recommend
		// intentionally shows two lines: the first dead, the second live.
		const reEvents = [...events, { id: 'e3', type: 'added', videoId: 'v2', title: 'Taken Back', actorClientId: me, at: at + 5000 }];
		const rePlaylist = [...playlist, { videoId: 'v2', title: 'Taken Back', addedBy: me, addedByName: 'Aidan', addedAt: at + 5000 }];
		const after = buildFeed({ events: reEvents, playlist: rePlaylist }, me)
			.flatMap((g) => g.items)
			.filter((i) => i.type === 'system' && i.event.videoId === 'v2');
		expect(after.map((i) => [i.event.id, i.removed])).toEqual([
			['e2', true], // superseded by e3 — dead even though v2 is live again
			['e3', false], // the newest Event for v2 is the one live line
		]);
		// The recommender's own lines follow the identical per-Event rule.
		expect(after.map((i) => i.own)).toEqual([true, true]);
	});

	it('systemLine: a struck System Message renders no anchor and explains itself to assistive tech', () => {
		const roster: RosterEntry[] = [{ clientId: 'bob22222', name: 'Bob' }];
		const event = { id: 'e1', videoId: 'v1', title: 'Otters 101', actorClientId: 'bob22222' };

		// Live: the title is the row's only link, tooltip intact, no struck extras.
		const live = window.YTB.systemLine({ type: 'system', own: false, removed: false, event }, roster);
		expect(live.struck).toBe(false);
		expect(live.prefix).toBe('Bob recommended ');
		expect(live.label).toBe('Otters 101');
		expect(live.suffix).toBe('');
		expect(live.linkVideoId).toBe('v1');
		expect(live.linkTooltip).toBe('Watch "Otters 101"');
		expect(live.rowTooltip).toBeNull();
		expect(live.srSuffix).toBeNull();

		// Struck: NO anchor — a null linkVideoId routes the title onto the
		// plain-text fallback (muted, unlinked, untooltipped) — and the row
		// carries the tooltip + visually-hidden suffix a line-through cannot
		// convey to a screen reader.
		const struck = window.YTB.systemLine({ type: 'system', own: false, removed: true, event }, roster);
		expect(struck.struck).toBe(true);
		expect(struck.label).toBe('Otters 101'); // the stored title survives, as plain text
		expect(struck.linkVideoId).toBeNull();
		expect(struck.linkTooltip).toBeNull();
		expect(struck.rowTooltip).toBe('No longer recommended');
		expect(struck.srSuffix).toBe(' (no longer recommended)');

		// The identical rule on the viewer's own "You recommended ..." line.
		const own = window.YTB.systemLine({ type: 'system', own: true, removed: true, event }, roster);
		expect(own.prefix).toBe('You recommended ');
		expect(own.suffix).toBe(' to the Room');
		expect(own.linkVideoId).toBeNull();
		expect(own.rowTooltip).toBe('No longer recommended');
	});

	it('Watch Notices: the recommender sees a Buddy watch their pick; others do not', () => {
		const at = new Date(2026, 6, 4, 12).getTime();
		// I (me) recommended v9 ("Otters"); a Buddy recommended v8.
		const playlist = [
			{ videoId: 'v9', title: 'Otters', addedBy: me, addedByName: 'Aidan', addedAt: at },
			{ videoId: 'v8', title: 'Cats', addedBy: 'bob22222', addedByName: 'Bob', addedAt: at },
		];
		const progress = [
			{ clientId: 'bob22222', name: 'Bob', videoId: 'v9', timestamp: 30, duration: 100, updatedAt: at + 5000 },
			{ clientId: 'ana33333', name: 'Ana', videoId: 'v9', timestamp: 10, duration: 100, updatedAt: at + 6000 },
			// A Buddy on a video I did NOT recommend -> no notice.
			{ clientId: 'cid44444', name: 'Cid', videoId: 'v3', timestamp: 5, duration: 100, updatedAt: at + 7000 },
			// My own record on my own pick -> not a Watch Notice (Buddies only).
			{ clientId: me, name: 'Aidan', videoId: 'v9', timestamp: 40, duration: 100, updatedAt: at + 8000 },
		];

		// As the recommender: one notice per Buddy on my pick, titled from the
		// live Recommendation, timestamped by each record's updatedAt.
		const mine = buildFeed({ playlist, progress }, me).flatMap((g) => g.items);
		const watches = mine.filter((i) => i.type === 'watch');
		expect(watches).toHaveLength(2);
		expect(watches.map((w) => w.clientId).sort()).toEqual(['ana33333', 'bob22222']);
		expect(watches.every((w) => w.title === 'Otters' && w.videoId === 'v9')).toBe(true);
		expect(watches.map((w) => w.at).sort()).toEqual([at + 5000, at + 6000]);
		expect(watches.find((w) => w.clientId === 'bob22222')!.name).toBe('Bob');

		// Another member (Bob recommended v8; nobody has a record for it) sees no
		// Watch Notice for my pick — Watch Notices go only to the recommender.
		const bobsFeed = buildFeed({ playlist, progress }, 'bob22222').flatMap((g) => g.items);
		expect(bobsFeed.some((i) => i.type === 'watch')).toBe(false);
	});

	it('labels Feed day dividers as Today / Yesterday / short date', () => {
		const now = new Date(2026, 6, 5, 15, 0, 0).getTime();
		const keyOf = (ms: number) =>
			buildFeed({ events: [{ id: 'e', type: 'added', videoId: 'v', actorClientId: 'a', at: ms }] }, 'me')[0].dayKey;
		expect(window.YTB.dayLabel(keyOf(now), now)).toBe('Today');
		expect(window.YTB.dayLabel(keyOf(now - 24 * 3600_000), now)).toBe('Yesterday');
		expect(window.YTB.dayLabel(keyOf(new Date(2026, 6, 3, 12).getTime()), now)).toMatch(/Jul/);
	});

	it('tailFeed windows the newest N items, keeps partial-day dividers, and counts the hidden', () => {
		const item = (at: number) => ({ type: 'system', at }) as FeedItem;
		const groups: FeedGroup[] = [
			{ dayKey: '2026-07-01', items: [item(1), item(2), item(3)] },
			{ dayKey: '2026-07-02', items: [item(4), item(5)] },
			{ dayKey: '2026-07-03', items: [item(6)] },
		];

		// A limit above or exactly at the total hides nothing: every day intact.
		for (const limit of [10, 6]) {
			const all = tailFeed(groups, limit);
			expect(all.hidden).toBe(0);
			expect(all.groups).toEqual(groups);
		}

		// A limit below the total splits a day: the partly revealed day keeps its
		// divider with only its newest items (the window is item-level, not
		// day-level), and the hidden count is the trimmed remainder.
		const four = tailFeed(groups, 4);
		expect(four.hidden).toBe(2);
		expect(four.groups.map((g) => g.dayKey)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
		expect(four.groups[0].items.map((i) => i.at)).toEqual([3]);
		expect(four.groups[1].items.map((i) => i.at)).toEqual([4, 5]);

		// A day left with no revealed items renders no divider at all.
		const two = tailFeed(groups, 2);
		expect(two.hidden).toBe(4);
		expect(two.groups.map((g) => g.dayKey)).toEqual(['2026-07-02', '2026-07-03']);
		expect(two.groups[0].items.map((i) => i.at)).toEqual([5]);

		// A limit of 0 hides everything; empty input trims (and hides) nothing.
		expect(tailFeed(groups, 0)).toEqual({ groups: [], hidden: 6 });
		expect(tailFeed([], 20)).toEqual({ groups: [], hidden: 0 });

		// Pure: the input groups and their item arrays were never mutated.
		expect(groups.map((g) => g.items.map((i) => i.at))).toEqual([[1, 2, 3], [4, 5], [6]]);
	});

	it('defaults the Room Home Toggle to visible and round-trips a hide per install', async () => {
		storage = {};
		await expect(window.YTB.getHomeSectionHidden()).resolves.toBe(false);

		await window.YTB.setHomeSectionHidden(true);
		expect(storage.homeSectionHidden).toBe(true);
		await expect(window.YTB.getHomeSectionHidden()).resolves.toBe(true);

		await window.YTB.setHomeSectionHidden(false);
		await expect(window.YTB.getHomeSectionHidden()).resolves.toBe(false);
	});

	it('stores the Room Home Toggle as a strict boolean, ignoring junk values', async () => {
		storage = {};
		await window.YTB.setHomeSectionHidden('yes' as unknown as boolean);
		expect(storage.homeSectionHidden).toBe(false);

		storage = { homeSectionHidden: 'truthy junk' };
		await expect(window.YTB.getHomeSectionHidden()).resolves.toBe(false);
	});
});

describe('settings (per install)', () => {
	it('defaults every Settings key and coerces junk back to the documented defaults', async () => {
		storage = {};
		await expect(window.YTB.getSettings()).resolves.toEqual({
			theme: 'system',
			spoilerDefault: true,
			notificationPosition: 'bottom',
			notesHidden: false,
			buddyProgressHidden: false,
		});

		storage = {
			theme: 'sepia',
			spoilerDefault: 'nope',
			notificationPosition: 'middle-center',
			notesHidden: 1,
			buddyProgressHidden: 'yes',
		};
		await expect(window.YTB.getSettings()).resolves.toEqual({
			theme: 'system',
			spoilerDefault: true,
			notificationPosition: 'bottom',
			notesHidden: false,
			buddyProgressHidden: false,
		});
	});

	// Installs predating the four-edge set may hold an 8-zone value; it is simply
	// not a legal edge, so the existing validation coerces it to the default.
	it('coerces a stale 8-zone stored Notification Position to the bottom default', async () => {
		for (const stale of ['top-right', 'middle-left', 'bottom-center']) {
			storage = { notificationPosition: stale };
			await expect(window.YTB.getSettings()).resolves.toMatchObject({ notificationPosition: 'bottom' });
		}
	});

	it('round-trips every Settings key and merge-writes partials', async () => {
		storage = {};
		await window.YTB.setSettings({
			theme: 'dark',
			spoilerDefault: false,
			notificationPosition: 'top',
			notesHidden: true,
			buddyProgressHidden: true,
		});
		await expect(window.YTB.getSettings()).resolves.toEqual({
			theme: 'dark',
			spoilerDefault: false,
			notificationPosition: 'top',
			notesHidden: true,
			buddyProgressHidden: true,
		});

		// A partial write leaves every other key untouched.
		await window.YTB.setSettings({ theme: 'light' });
		await expect(window.YTB.getSettings()).resolves.toMatchObject({ theme: 'light', notesHidden: true, notificationPosition: 'top' });
	});

	it('validates writes: illegal theme/edge values are dropped, flags become strict booleans', async () => {
		storage = {};
		await window.YTB.setSettings({
			theme: 'sepia',
			notificationPosition: 'top-right', // a stale 8-zone name is not an edge
			spoilerDefault: 'yes' as unknown as boolean,
		});
		expect(storage.theme).toBeUndefined();
		expect(storage.notificationPosition).toBeUndefined();
		expect(storage.spoilerDefault).toBe(false);
	});

	it('exposes the three themes and the four edges', () => {
		expect(window.YTB.THEMES).toEqual(['light', 'dark', 'system']);
		expect(window.YTB.NOTIFICATION_EDGES).toHaveLength(4);
		expect(new Set(window.YTB.NOTIFICATION_EDGES)).toEqual(new Set(['top', 'bottom', 'left', 'right']));
		expect(window.YTB.NOTIFICATION_EDGES).toContain('bottom');
	});

	it('themeMarker maps preference x page-darkness to the data-theme value (ADR-0009)', () => {
		const marker = window.YTB.themeMarker;
		// Forced Light/Dark win regardless of the surrounding page (or its absence).
		for (const pageDark of [true, false, null]) {
			expect(marker('light', pageDark)).toBe('light');
			expect(marker('dark', pageDark)).toBe('dark');
		}
		// Auto ('system') on a YouTube page follows YouTube's own theme.
		expect(marker('system', true)).toBe('dark');
		expect(marker('system', false)).toBe('light');
		// Auto off-page (the popup, pageDark null) leaves the marker unset so the
		// OS @media (prefers-color-scheme) fallback rules.
		expect(marker('system', null)).toBeNull();
		// Any unexpected/absent preference is treated as Auto.
		expect(marker(undefined as unknown as string, true)).toBe('dark');
		expect(marker('sepia', false)).toBe('light');
		expect(marker('sepia', null)).toBeNull();
	});
});

describe('recommended for you helpers (ADR-0007)', () => {
	const playlist = [
		{ videoId: 'v1', title: 'Mine', addedBy: 'me111111', addedAt: 1000 },
		{ videoId: 'v2', title: 'Bob 1', addedBy: 'bob22222', addedAt: 2000 },
		{ videoId: 'v3', title: 'Ana 1', addedBy: 'ana33333', addedAt: 3000 },
		{ videoId: 'v4', title: 'Bob 2', addedBy: 'bob22222', addedAt: 4000 },
	];

	it('filters the grid to Buddy Recommendations minus Dismissed, newest first', () => {
		// Own Recommendations never appear, even with nothing Dismissed.
		expect(window.YTB.recommendedForYou(playlist, 'me111111', []).map((i: PlaylistRec) => i.videoId)).toEqual(['v4', 'v3', 'v2']);
		// A Dismissed videoId is hidden for this viewer only (pure filter).
		expect(window.YTB.recommendedForYou(playlist, 'me111111', ['v3']).map((i: PlaylistRec) => i.videoId)).toEqual(['v4', 'v2']);
		// Dismissing every foreign item empties the grid.
		expect(window.YTB.recommendedForYou(playlist, 'me111111', ['v2', 'v3', 'v4'])).toEqual([]);
		// A member with no Recommendations of their own sees the whole list.
		expect(window.YTB.recommendedForYou(playlist, 'zoe77777', undefined).map((i: PlaylistRec) => i.videoId)).toEqual([
			'v4',
			'v3',
			'v2',
			'v1',
		]);
		// Defensive: an absent Room read yields an empty grid.
		expect(window.YTB.recommendedForYou(undefined, 'me111111', [])).toEqual([]);
	});

	it('stores Dismissals per Room in chrome.storage.local, idempotently, without any backend call', async () => {
		storage = {};
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.dismissedVideoIds('room-a')).resolves.toEqual([]);
		await window.YTB.dismissVideo('room-a', 'v1');
		await window.YTB.dismissVideo('room-a', 'v2');
		await window.YTB.dismissVideo('room-a', 'v1'); // idempotent re-dismiss
		await window.YTB.dismissVideo('room-b', 'v9'); // Room-scoped, like Buddy Colors

		await expect(window.YTB.dismissedVideoIds('room-a')).resolves.toEqual(['v1', 'v2']);
		await expect(window.YTB.dismissedVideoIds('room-b')).resolves.toEqual(['v9']);
		expect(storage.dismissedVideos).toEqual({ 'room-a': ['v1', 'v2'], 'room-b': ['v9'] });
		// A Dismiss is private and local: it never reaches the backend.
		expect(fetchMock).not.toHaveBeenCalled();

		// Unpaired (no code) reads empty and writes nothing.
		await expect(window.YTB.dismissedVideoIds('')).resolves.toEqual([]);
		await window.YTB.dismissVideo('', 'v1');
		expect(storage.dismissedVideos).toEqual({ 'room-a': ['v1', 'v2'], 'room-b': ['v9'] });
	});

	it('defaults malformed Dismissal storage and skips an idempotent write', async () => {
		storage = { dismissedVideos: 'junk' };
		await expect(window.YTB.dismissedVideoIds('room')).resolves.toEqual([]);

		storage = { dismissedVideos: { room: 'junk', other: ['kept'] } };
		vi.mocked(chrome.storage.local.set).mockClear();
		await expect(window.YTB.dismissVideo('room', 'v2')).resolves.toEqual(['v2']);
		expect(storage.dismissedVideos).toEqual({ room: ['v2'], other: ['kept'] });
		expect(chrome.storage.local.set).toHaveBeenCalledOnce();

		vi.mocked(chrome.storage.local.set).mockClear();
		await expect(window.YTB.dismissVideo('room', 'v2')).resolves.toEqual(['v2']);
		expect(chrome.storage.local.set).not.toHaveBeenCalled();
	});

	it('hides a Dismissed videoId even after a later re-recommend (keyed by videoId)', async () => {
		storage = { dismissedVideos: { room: ['v2'] } };
		const dismissed = await window.YTB.dismissedVideoIds('room');
		const rerecommended = [{ videoId: 'v2', title: 'Bob 1 again', addedBy: 'bob22222', addedAt: 9000 }];
		expect(window.YTB.recommendedForYou(rerecommended, 'me111111', dismissed)).toEqual([]);
	});
});

describe('the optimistic Recommend Control (Recommend Intent overlay)', () => {
	const me = 'me111111';
	const buddy = 'bob22222';
	const state = (args: object) => window.YTB.recommendPillState(args);
	const settled = (args: object) => window.YTB.recommendIntentSettled(args);

	it('renders the three Room-driven states with no pending intent', () => {
		expect(state({ addedBy: undefined, myClientId: me })).toBe('idle');
		expect(state({ addedBy: me, myClientId: me })).toBe('recommended');
		expect(state({ addedBy: buddy, myClientId: me })).toBe('added');
		// An unknown own clientId can never claim a Recommendation as ours.
		expect(state({ addedBy: buddy, myClientId: null })).toBe('added');
	});

	it("overlays a pending 'mine' so a stale Room read cannot flip the pill back", () => {
		// The just-clicked recommend shows Unrecommend before any response...
		expect(state({ addedBy: undefined, myClientId: me, pending: 'mine' })).toBe('recommended');
		// ...and a Room read that already carries my item changes nothing.
		expect(state({ addedBy: me, myClientId: me, pending: 'mine' })).toBe('recommended');
	});

	it("overlays a pending 'absent' so a stale Room read still shows the un-recommend", () => {
		// The Room read that raced the DELETE still carries my item; the pill
		// must keep offering to recommend again, not flash back to Unrecommend.
		expect(state({ addedBy: me, myClientId: me, pending: 'absent' })).toBe('idle');
		expect(state({ addedBy: undefined, myClientId: me, pending: 'absent' })).toBe('idle');
	});

	it("lets the server's addedBy win the Buddy-already-recommended reconcile", () => {
		// My add was a no-op onto the Buddy's item: their addedBy outranks the
		// optimistic guess — the pill corrects to "Recommended to you".
		expect(state({ addedBy: buddy, myClientId: me, pending: 'mine' })).toBe('added');
	});

	it("settles 'mine' once ANY addedBy exists — mine or the no-op'd Buddy's", () => {
		expect(settled({ addedBy: me, myClientId: me, pending: 'mine' })).toBe(true);
		expect(settled({ addedBy: buddy, myClientId: me, pending: 'mine' })).toBe(true);
		// A read without the item has not caught up: keep overlaying.
		expect(settled({ addedBy: undefined, myClientId: me, pending: 'mine' })).toBe(false);
	});

	it("settles 'absent' only once the addedBy is gone", () => {
		expect(settled({ addedBy: undefined, myClientId: me, pending: 'absent' })).toBe(true);
		expect(settled({ addedBy: me, myClientId: me, pending: 'absent' })).toBe(false);
		expect(settled({ addedBy: buddy, myClientId: me, pending: 'absent' })).toBe(false);
	});

	it('treats no pending intent as vacuously settled (nothing to hold)', () => {
		expect(settled({ addedBy: me, myClientId: me })).toBe(true);
		expect(settled({ addedBy: undefined, myClientId: me, pending: undefined })).toBe(true);
	});

	it('Feed-mirror no-drift: after a settle the pill is driven purely by Room data', () => {
		// The exact sequence the pill lives through: optimistic flip, stale read
		// (overlay holds), fresh read (settle), then Room data alone.
		expect(state({ addedBy: undefined, myClientId: me, pending: 'mine' })).toBe('recommended');
		expect(settled({ addedBy: undefined, myClientId: me, pending: 'mine' })).toBe(false);
		expect(settled({ addedBy: me, myClientId: me, pending: 'mine' })).toBe(true);
		expect(state({ addedBy: me, myClientId: me })).toBe('recommended');
	});
});

describe('the single buddyColors storage subscription (live Buddy Color repaint)', () => {
	it('registers exactly one listener, refreshes the cache, and rebroadcasts ytb:buddy-colors', () => {
		// shared.js is the ONE owner of the subscription: loading it (beforeAll)
		// registered exactly one buddyColors listener, so correctness never
		// depends on content-script load order.
		const registrations = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
		expect(registrations).toHaveLength(1);
		const onChanged = registrations[0][0];

		// The cache refresh is observable through buddyColor's Room-scoped read.
		// This file runs in workerd, where `document` is undefined — the load in
		// beforeAll and this call not throwing IS the no-document guarantee.
		onChanged({ buddyColors: { newValue: { room: { bud: '#f0a500' } } } }, 'local');
		expect(window.YTB.buddyColor('bud', 'room')).toBe('#f0a500');

		// With a document present the same change also rebroadcasts — the event
		// the on-page consumers (renderer, notes, home-section) repaint from.
		const dispatchEvent = vi.fn();
		(globalThis as { document?: unknown }).document = { dispatchEvent };
		try {
			onChanged({ buddyColors: { newValue: { room: { bud: '#00a86b' } } } }, 'local');
		} finally {
			delete (globalThis as { document?: unknown }).document;
		}
		expect(window.YTB.buddyColor('bud', 'room')).toBe('#00a86b');
		expect(dispatchEvent).toHaveBeenCalledOnce();
		expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe('ytb:buddy-colors');

		// Non-local areas and unrelated keys leave the cache alone.
		onChanged({ buddyColors: { newValue: { room: { bud: '#d936c7' } } } }, 'sync');
		onChanged({ theme: { newValue: 'dark' } }, 'local');
		expect(window.YTB.buddyColor('bud', 'room')).toBe('#00a86b');

		// A cleared value empties the cache back to the default palette color.
		onChanged({ buddyColors: { newValue: undefined } }, 'local');
		expect(window.YTB.buddyColor('bud', 'room')).toBe(window.YTB.BUDDY_COLORS[0]);
	});
});

describe('Unseen Mentions & Replies (ADR-0010)', () => {
	const me = 'me111111';
	// One Room read exercising every Unseen rule at once. n-reaction carries a
	// deliberately malformed `mentions` (the composer never sends one for a
	// Reaction) to prove the derivation excludes Reactions structurally.
	const notes = [
		{ id: 'n-mention', clientId: 'bob22222', videoId: 'v1', timestamp: 10, kind: 'text', body: 'look', mentions: [me], createdAt: 1000 },
		{ id: 'n-plain', clientId: 'bob22222', videoId: 'v1', timestamp: 20, kind: 'text', body: 'no mention', createdAt: 1100 },
		{ id: 'n-mine', clientId: me, videoId: 'v1', timestamp: 30, kind: 'text', body: 'my note', createdAt: 1200 },
		{
			id: 'n-spoiler',
			clientId: 'ana33333',
			videoId: 'v1',
			timestamp: 40,
			kind: 'text',
			body: 'the ending',
			spoiler: true,
			mentions: [me],
			createdAt: 1300,
		},
		{
			id: 'n-reaction',
			clientId: 'bob22222',
			videoId: 'v1',
			timestamp: 50,
			kind: 'emoji',
			body: '\u{1F525}',
			mentions: [me],
			createdAt: 1400,
		},
		{ id: 'n-self', clientId: me, videoId: 'v1', timestamp: 60, kind: 'text', body: 'me @ me', mentions: [me], createdAt: 1500 },
	];
	const replies = [
		{ id: 'r-to-mine', clientId: 'bob22222', noteId: 'n-mine', body: 'nice', createdAt: 2000 },
		{ id: 'r-mention', clientId: 'ana33333', noteId: 'n-plain', body: 'hey', mentions: [me], createdAt: 2100 },
		{ id: 'r-mine', clientId: me, noteId: 'n-mention', body: 'thanks', createdAt: 2200 },
		{ id: 'r-others', clientId: 'ana33333', noteId: 'n-plain', body: 'between others', createdAt: 2300 },
		{ id: 'r-orphan', clientId: 'bob22222', noteId: 'n-gone', body: 'parent aged out', mentions: [me], createdAt: 2400 },
		{ id: 'r-on-reaction', clientId: 'bob22222', noteId: 'n-reaction', body: 'malformed', mentions: [me], createdAt: 2500 },
	];
	const records = { notes, replies };

	it('shares one "addressed to me" rule with the Room Feed (noteAddressesMe / replyAddressesMe)', () => {
		expect(window.YTB.noteAddressesMe(notes[0], me)).toBe(true); // foreign, mentions me
		expect(window.YTB.noteAddressesMe(notes[1], me)).toBe(false); // foreign, no mention
		expect(window.YTB.noteAddressesMe(notes[5], me)).toBe(false); // my own write is never news to me
		expect(window.YTB.noteAddressesMe(null, me)).toBe(false);

		const mine = notes[2];
		const foreign = notes[1];
		expect(window.YTB.replyAddressesMe(replies[0], mine, me)).toBe(true); // Buddy Reply under my Note
		expect(window.YTB.replyAddressesMe(replies[1], foreign, me)).toBe(true); // Mentions me under anyone's Note
		expect(window.YTB.replyAddressesMe(replies[3], foreign, me)).toBe(false); // Buddies talking to each other
		expect(window.YTB.replyAddressesMe(replies[2], notes[0], me)).toBe(false); // my own Reply
		expect(window.YTB.replyAddressesMe(replies[4], null, me)).toBe(true); // a Mention needs no parent to address me
	});

	it('derives the pulsing dots: Mentions and addressed Replies, never own writes or Reactions', () => {
		// n-mention (Mention), n-spoiler (a locked Spoiler CAN pulse), n-mine (a
		// Buddy replied to my Note), n-plain (a Reply beneath it Mentions me).
		// NOT n-reaction (a Reaction never pulses, even malformed), NOT n-self
		// (own writes), and r-orphan has no dot to anchor to.
		expect(window.YTB.unseenNoteIds(records, me, []).sort()).toEqual(['n-mention', 'n-mine', 'n-plain', 'n-spoiler']);
		// Another member sees their own Unseen set, not mine: bob's Notes pulse
		// for bob where others replied beneath them (r-mine, r-mention, r-others),
		// and ana — whom nothing addresses — sees no pulse at all.
		expect(window.YTB.unseenNoteIds(records, 'bob22222', []).sort()).toEqual(['n-mention', 'n-plain']);
		expect(window.YTB.unseenNoteIds(records, 'ana33333', [])).toEqual([]);
		// Defensive: an absent read pulses nothing.
		expect(window.YTB.unseenNoteIds(undefined as never, me, [])).toEqual([]);
	});

	it('drops seen ids from the pulse set', () => {
		expect(window.YTB.unseenNoteIds(records, me, ['n-mention', 'r-to-mine']).sort()).toEqual(['n-plain', 'n-spoiler']);
		expect(window.YTB.unseenNoteIds(records, me, ['n-mention', 'n-spoiler', 'r-to-mine', 'r-mention'])).toEqual([]);
	});

	it('Acknowledge clears exactly the ids anchored to one dot', () => {
		expect(window.YTB.acknowledgeTargets(records, me, 'n-mention')).toEqual(['n-mention']); // my own r-mine is not included
		expect(window.YTB.acknowledgeTargets(records, me, 'n-mine')).toEqual(['r-to-mine']); // my Note itself is not addressed to me
		expect(window.YTB.acknowledgeTargets(records, me, 'n-plain')).toEqual(['r-mention']); // r-others is not addressed to me
		expect(window.YTB.acknowledgeTargets(records, me, 'n-spoiler')).toEqual(['n-spoiler']);
		expect(window.YTB.acknowledgeTargets(records, me, 'n-reaction')).toEqual([]);
		expect(window.YTB.acknowledgeTargets(records, me, 'n-gone')).toEqual([]);
	});

	it('Acknowledging one dot stops only that pulse', async () => {
		storage = {};
		const ids = window.YTB.acknowledgeTargets(records, me, 'n-mine');
		const seen = await window.YTB.markSeen('room', ids);
		expect(window.YTB.unseenNoteIds(records, me, seen).sort()).toEqual(['n-mention', 'n-plain', 'n-spoiler']);
	});

	it('never drifts from the Room Feed: pulsing dots are exactly the dots the Feed anchors items to', () => {
		// Restricted to well-formed records: the Feed also surfaces a Reply whose
		// parent is gone (nothing on the timeline can anchor it) and would list a
		// malformed Reaction Mention; neither exists in real data.
		const wellFormed = {
			notes: notes.filter((note) => note.id !== 'n-reaction'),
			replies: replies.filter((reply) => reply.id !== 'r-on-reaction' && reply.id !== 'r-orphan'),
		};
		const anchors = new Set<string>();
		for (const group of buildFeed(wellFormed, me)) {
			for (const item of group.items) {
				if (item.type !== 'reply' && item.type !== 'mention') continue;
				if (item.note) anchors.add(item.note.id);
			}
		}
		expect(new Set(window.YTB.unseenNoteIds(wellFormed, me, []))).toEqual(anchors);
	});

	it('stores Acknowledged ids per Room in chrome.storage.local, idempotently, without any backend call', async () => {
		storage = {};
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(window.YTB.seenIds('room-a')).resolves.toEqual([]);
		await window.YTB.markSeen('room-a', ['n1', 'r1']);
		await window.YTB.markSeen('room-a', ['r1', 'r2']); // overlapping Acknowledge: idempotent
		await window.YTB.markSeen('room-b', ['n9']); // Room-scoped, like a Dismiss

		await expect(window.YTB.seenIds('room-a')).resolves.toEqual(['n1', 'r1', 'r2']);
		await expect(window.YTB.seenIds('room-b')).resolves.toEqual(['n9']);
		expect(storage.seenItems).toEqual({ 'room-a': ['n1', 'r1', 'r2'], 'room-b': ['n9'] });
		// Seen state is private and local: no request ever carries it to the backend.
		expect(fetchMock).not.toHaveBeenCalled();

		// Unpaired (no code) reads empty and writes nothing; junk ids are dropped.
		await expect(window.YTB.seenIds('')).resolves.toEqual([]);
		await window.YTB.markSeen('', ['n1']);
		await window.YTB.markSeen('room-a', ['', 123 as unknown as string]);
		expect(storage.seenItems).toEqual({ 'room-a': ['n1', 'r1', 'r2'], 'room-b': ['n9'] });
	});

	it('defaults malformed seen storage while preserving order, other Rooms, and no-op writes', async () => {
		storage = { seenItems: 'junk' };
		await expect(window.YTB.seenIds('room')).resolves.toEqual([]);

		storage = { seenItems: { room: 'junk', other: ['kept'] } };
		vi.mocked(chrome.storage.local.set).mockClear();
		await expect(window.YTB.markSeen('room', ['n2', '', 123 as unknown as string, 'n1', 'n2'])).resolves.toEqual(['n2', 'n1']);
		expect(storage.seenItems).toEqual({ room: ['n2', 'n1'], other: ['kept'] });
		expect(chrome.storage.local.set).toHaveBeenCalledOnce();

		vi.mocked(chrome.storage.local.set).mockClear();
		await expect(window.YTB.markSeen('room', ['n1', 'n2'])).resolves.toEqual(['n2', 'n1']);
		expect(chrome.storage.local.set).not.toHaveBeenCalled();
	});

	it('prunes the seen set against a Room read, keeping other Rooms intact', async () => {
		storage = { seenItems: { room: ['n1', 'r1', 'r-deleted'], other: ['n9'] } };
		await expect(window.YTB.pruneSeen('room', ['n1', 'r1', 'n-new'])).resolves.toEqual(['n1', 'r1']);
		expect(storage.seenItems).toEqual({ room: ['n1', 'r1'], other: ['n9'] });
		// Nothing aged out: the write is skipped and the list survives unchanged.
		await expect(window.YTB.pruneSeen('room', ['n1', 'r1'])).resolves.toEqual(['n1', 'r1']);
		// Unpaired: nothing to prune, nothing written.
		await expect(window.YTB.pruneSeen('', ['n1'])).resolves.toEqual([]);
		expect(storage.seenItems).toEqual({ room: ['n1', 'r1'], other: ['n9'] });
	});
});

describe('pending arrival handshake (Room Feed row -> notes.js)', () => {
	it('round-trips a videoId, stamping it with a time', async () => {
		storage = {};
		await expect(window.YTB.setPendingArrival('v1')).resolves.toBe(true);
		const stored = storage.pendingArrival as { videoId: string; at: number };
		expect(stored).toMatchObject({ videoId: 'v1' });
		expect(typeof stored.at).toBe('number');
		await expect(window.YTB.getPendingArrival()).resolves.toMatchObject({ videoId: 'v1' });
	});

	it('rejects a missing videoId without writing anything', async () => {
		storage = {};
		await expect(window.YTB.setPendingArrival('' as never)).resolves.toBe(false);
		await expect(window.YTB.setPendingArrival(null as never)).resolves.toBe(false);
		expect('pendingArrival' in storage).toBe(false);
	});

	it('treats an arrival past its TTL, or a garbage value, as absent', async () => {
		storage = { pendingArrival: { videoId: 'v1', at: Date.now() - window.YTB.PENDING_ARRIVAL_TTL_MS - 1 } };
		await expect(window.YTB.getPendingArrival()).resolves.toBeNull();
		storage = { pendingArrival: 'junk' };
		await expect(window.YTB.getPendingArrival()).resolves.toBeNull();
		storage = { pendingArrival: {} };
		await expect(window.YTB.getPendingArrival()).resolves.toBeNull();
	});

	it('clears the slot idempotently', async () => {
		storage = { pendingArrival: { videoId: 'v1', at: Date.now() } };
		await window.YTB.clearPendingArrival();
		await expect(window.YTB.getPendingArrival()).resolves.toBeNull();
		await window.YTB.clearPendingArrival(); // idempotent
		await expect(window.YTB.getPendingArrival()).resolves.toBeNull();
	});
});

describe('Controls Hold (the refcounted chrome-awake core)', () => {
	// The core behind YTB.controlsHold, built with injected dispatch/timer seams
	// so every contract is observable: the real singleton only swaps in the DOM
	// mousemove dispatch and real interval timers.
	type Hold = { acquire: () => () => void; holders: () => number };
	const makeHold = () => {
		const dispatch = vi.fn();
		const setTimer = vi.fn((_fn: () => void, _ms: number): unknown => 'timer-1');
		const clearTimer = vi.fn();
		const hold: Hold = window.YTB.createControlsHold({ dispatch, tickMs: 1500, setTimer, clearTimer });
		return { hold, dispatch, setTimer, clearTimer };
	};

	it("keeps the ticker period comfortably inside YouTube's ~3s autohide window", () => {
		expect(window.YTB.CONTROLS_HOLD_TICK_MS).toBeGreaterThanOrEqual(1000);
		expect(window.YTB.CONTROLS_HOLD_TICK_MS).toBeLessThanOrEqual(2000);
	});

	it('starts the ticker on the FIRST acquire only, feeding immediately', () => {
		const { hold, dispatch, setTimer } = makeHold();
		expect(hold.holders()).toBe(0);
		expect(dispatch).not.toHaveBeenCalled();

		hold.acquire();
		expect(hold.holders()).toBe(1);
		expect(dispatch).toHaveBeenCalledTimes(1); // wake NOW — a parked pointer is invisible to YouTube
		expect(setTimer).toHaveBeenCalledTimes(1);
		expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1500);

		hold.acquire(); // a second holder joins the SAME ticker
		expect(hold.holders()).toBe(2);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(setTimer).toHaveBeenCalledTimes(1);
	});

	it('each tick feeds the dispatch with an advancing counter (the jitter seam)', () => {
		const { hold, dispatch, setTimer } = makeHold();
		hold.acquire();
		const tick = setTimer.mock.calls[0][0];
		tick();
		tick();
		expect(dispatch.mock.calls.map(([n]) => n)).toEqual([0, 1, 2]);
	});

	it('stops the ticker only when the LAST holder releases', () => {
		const { hold, clearTimer } = makeHold();
		const releaseDot = hold.acquire();
		const releasePanel = hold.acquire();

		releaseDot();
		expect(hold.holders()).toBe(1);
		expect(clearTimer).not.toHaveBeenCalled(); // the panel still holds

		releasePanel();
		expect(hold.holders()).toBe(0);
		expect(clearTimer).toHaveBeenCalledTimes(1);
		expect(clearTimer).toHaveBeenCalledWith('timer-1');
	});

	it('a release is one-shot: double-releasing never underflows a sibling hold', () => {
		const { hold, clearTimer } = makeHold();
		const releaseA = hold.acquire();
		hold.acquire();

		releaseA();
		releaseA(); // a sweep racing the real mouseleave, a duplicate DOM event...
		expect(hold.holders()).toBe(1); // ...decrements exactly once
		expect(clearTimer).not.toHaveBeenCalled();
	});

	it('never dispatches after the last release, even for an already-queued tick', () => {
		const { hold, dispatch, setTimer } = makeHold();
		const release = hold.acquire();
		const tick = setTimer.mock.calls[0][0];

		release();
		dispatch.mockClear();
		tick(); // the interval callback that was in flight when the hold released
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('re-acquiring after a full release starts a fresh ticker with a fresh immediate feed', () => {
		const { hold, dispatch, setTimer } = makeHold();
		hold.acquire()();
		expect(hold.holders()).toBe(0);

		dispatch.mockClear();
		hold.acquire();
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(setTimer).toHaveBeenCalledTimes(2);
	});

	it('exposes the ONE shared instance both notes.js and composer.js consume', () => {
		expect(window.YTB.controlsHold).toBeDefined();
		expect(typeof window.YTB.controlsHold.acquire).toBe('function');
		expect(typeof window.YTB.controlsHold.holders).toBe('function');
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

		vi.mocked(chrome.storage.local.set).mockClear();
		await expect(window.YTB.dismissedVideoIds('room')).resolves.toEqual([]);
		await expect(window.YTB.dismissVideo('room', 'v1')).resolves.toEqual([]);
		await expect(window.YTB.seenIds('room')).resolves.toEqual([]);
		await expect(window.YTB.markSeen('room', ['n1'])).resolves.toEqual([]);
		await expect(window.YTB.pruneSeen('room', ['n1'])).resolves.toEqual([]);
		expect(chrome.storage.local.get).toHaveBeenCalledTimes(callsAfterInvalidation);
		expect(chrome.storage.local.set).not.toHaveBeenCalled();
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
			recommendedForYou(
				playlist: Array<{ videoId: string; addedBy: string; addedAt: number }> | undefined,
				myClientId: string,
				dismissedVideoIds?: Iterable<string>,
			): Array<{ videoId: string; addedBy: string; addedAt: number }>;
			dismissedVideoIds(code: string): Promise<string[]>;
			dismissVideo(code: string, videoId: string): Promise<string[]>;
			noteAddressesMe(note: { clientId?: string; mentions?: string[] } | null, myClientId: string): boolean;
			replyAddressesMe(
				reply: { clientId?: string; mentions?: string[] } | null,
				parentNote: { clientId?: string } | null,
				myClientId: string,
			): boolean;
			unseenNoteIds(records: object, myClientId: string, seenIds?: Iterable<string>): string[];
			acknowledgeTargets(records: object, myClientId: string, noteId: string): string[];
			seenIds(code: string): Promise<string[]>;
			markSeen(code: string, ids: Iterable<string>): Promise<string[]>;
			pruneSeen(code: string, liveIds: Iterable<string>): Promise<string[]>;
			ADJECTIVES: string[];
			hashClientId(clientId: string): number;
			baseBuddyName(clientId: string, name?: string): string;
			buddyName(clientId: string, name?: string, roster?: Array<{ clientId: string; name?: string }>): string;
			disambiguateNames(roster: Array<{ clientId: string; name?: string }>): Map<string, string>;
			roomRoster(records: object): Array<{ clientId: string; name: string }>;
			filterRoster(roster: Array<{ clientId: string; name: string }>, query: string): Array<{ clientId: string; name: string }>;
			mentionName(roster: Array<{ clientId: string; name: string }>, clientId: string): string;
			watchTitle(doc: { querySelector(selector: string): { textContent: string } | null; title: string }): string;
			videoContext(note: { videoTitle?: string } | null): string;
			titleLinkTooltip(title: string | null): string;
			watchedByLabel(
				progress: object[],
				videoId: string,
				myClientId: string,
				roster?: Array<{ clientId: string; name?: string }>,
				options?: { buddiesOnly?: boolean },
			): string;
			buildFeed(
				records: object,
				myClientId: string,
			): Array<{
				dayKey: string;
				items: Array<{
					type: string;
					at: number;
					note?: { id: string } | null;
					reply?: object;
					event?: { actorClientId?: string; videoId?: string; title?: string; type?: string };
					videoId?: string;
					title?: string;
					clientId?: string;
					name?: string;
				}>;
			}>;
			dayLabel(dayKey: string, nowMs?: number): string;
			tailFeed<Group extends { dayKey: string; items: unknown[] }>(groups: Group[], limit: number): { groups: Group[]; hidden: number };
			getRecords(code: string): Promise<{ notes: object[]; replies: object[]; playlist?: object[]; events?: object[]; ok: boolean }>;
			getHomeSectionHidden(): Promise<boolean>;
			setHomeSectionHidden(hidden: boolean): Promise<boolean>;
			PENDING_ARRIVAL_TTL_MS: number;
			PANEL_LOAD_GRACE_MS: number;
			startArrivalGrace(now?: number): number;
			withinArrivalGrace(now?: number): boolean;
			cancelArrivalGrace(): void;
			playAction(state: { withinGrace: boolean; panelOpen: boolean }): 'hold' | 'dismiss' | 'ignore';
			CONTROLS_HOLD_TICK_MS: number;
			createControlsHold(deps: {
				dispatch: (tick: number) => void;
				tickMs?: number;
				setTimer?: (fn: () => void, ms: number) => unknown;
				clearTimer?: (id: unknown) => void;
			}): { acquire: () => () => void; holders: () => number };
			nudgePlayerControls(tick: number): void;
			controlsHold: { acquire: () => () => void; holders: () => number };
			pictureClickRegion(target: { closest?: (selector: string) => unknown } | null): 'picture' | 'chrome' | 'outside';
			pictureClickAction(state: {
				overlayOpen: boolean;
				region: 'picture' | 'chrome' | 'outside';
				pauseHold: boolean;
				withinGrace: boolean;
			}): { close: boolean; consume: boolean; play: boolean; cancelArrivalGrace: boolean };
			setPendingArrival(videoId: string): Promise<boolean>;
			getPendingArrival(): Promise<{ videoId: string; at: number } | null>;
			clearPendingArrival(): Promise<boolean>;
			THEMES: string[];
			NOTIFICATION_EDGES: string[];
			themeMarker(preference: string, pageDark: boolean | null): 'light' | 'dark' | null;
			getSettings(): Promise<{
				theme: string;
				spoilerDefault: boolean;
				notificationPosition: string;
				notesHidden: boolean;
				buddyProgressHidden: boolean;
			}>;
			setSettings(partial: {
				theme?: string;
				spoilerDefault?: boolean;
				notificationPosition?: string;
				notesHidden?: boolean;
				buddyProgressHidden?: boolean;
			}): Promise<boolean>;
			syncBuddyColors(code: string, ids: string[], successful: boolean, random?: () => number): Promise<Record<string, string>>;
			setBuddyColor(code: string, clientId: string, color: string): Promise<boolean>;
			clearRoomColors(code: string): Promise<void>;
			buddyColor(clientId: string, code?: string): string;
			BUDDY_COLORS: string[];
			relativeTime(thenMs: number, nowMs?: number): string;
			errorCopy(category: string, action: 'note' | 'reply' | 'reaction' | 'recommendation'): string;
			connectionState(prevFailures: number, ok: boolean): { failures: number; lost: boolean };
			crossedNotes<T extends { timestamp: number }>(notes: T[], previousTime: number, currentTime: number): T[];
			dotActivation(note: { kind?: string; spoiler?: boolean; timestamp?: number }): { action: 'open' };
			notePanelVariant(note: { kind?: string; spoiler?: boolean; timestamp?: number }, playhead: number): 'text' | 'reaction' | 'spoiler';
			nearNoteMoment(timestamp: number, playhead: number): boolean;
		};
	}
}
