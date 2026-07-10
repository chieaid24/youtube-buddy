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

	it('routes a video play: load-churn grace holds the panel, later plays dismiss it', () => {
		// No panel open: a play is nothing to do with the Expanded Note.
		expect(window.YTB.panelPlayAction({ panelOpen: false, withinGrace: true })).toBe('ignore');
		expect(window.YTB.panelPlayAction({ panelOpen: false, withinGrace: false })).toBe('ignore');
		// Panel open + inside the grace after a Room Feed open: autoplay settling in
		// must re-pause and keep it open, never dismiss.
		expect(window.YTB.panelPlayAction({ panelOpen: true, withinGrace: true })).toBe('hold');
		// Panel open + past the grace: a deliberate resume dismisses it as before.
		expect(window.YTB.panelPlayAction({ panelOpen: true, withinGrace: false })).toBe('dismiss');
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

// Tooltips for the Room Feed's two link kinds. Both name the destination the
// row's visible text leaves implicit.
describe('noteLinkTooltip', () => {
	it("names the Note's video and moment", () => {
		expect(window.YTB.noteLinkTooltip({ videoTitle: 'Blade Runner', timestamp: 412 })).toBe('Open this note on "Blade Runner" at 6:52');
	});

	it('drops the title clause when the Note captured none', () => {
		expect(window.YTB.noteLinkTooltip({ timestamp: 412 })).toBe('Open this note at 6:52');
		expect(window.YTB.noteLinkTooltip({ videoTitle: '   ', timestamp: 0 })).toBe('Open this note at 0:00');
	});

	it('formats past an hour and floors a fractional timestamp', () => {
		expect(window.YTB.noteLinkTooltip({ videoTitle: 'Long', timestamp: 3723.9 })).toBe('Open this note on "Long" at 1:02:03');
	});
});

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

	it('hides a Dismissed videoId even after a later re-recommend (keyed by videoId)', async () => {
		storage = { dismissedVideos: { room: ['v2'] } };
		const dismissed = await window.YTB.dismissedVideoIds('room');
		const rerecommended = [{ videoId: 'v2', title: 'Bob 1 again', addedBy: 'bob22222', addedAt: 9000 }];
		expect(window.YTB.recommendedForYou(rerecommended, 'me111111', dismissed)).toEqual([]);
	});
});

describe('pending Note open handshake (Room Feed row -> notes.js)', () => {
	it('round-trips a target, stamping it with a time', async () => {
		storage = {};
		await expect(window.YTB.setPendingNoteOpen({ videoId: 'v1', noteId: 'n1' })).resolves.toBe(true);
		const stored = storage.pendingNoteOpen as { videoId: string; noteId: string; at: number };
		expect(stored).toMatchObject({ videoId: 'v1', noteId: 'n1' });
		expect(typeof stored.at).toBe('number');
		await expect(window.YTB.getPendingNoteOpen()).resolves.toMatchObject({ videoId: 'v1', noteId: 'n1' });
	});

	it('rejects a malformed target without writing anything', async () => {
		storage = {};
		await expect(window.YTB.setPendingNoteOpen({ videoId: 'v1' } as never)).resolves.toBe(false);
		await expect(window.YTB.setPendingNoteOpen({ noteId: 'n1' } as never)).resolves.toBe(false);
		await expect(window.YTB.setPendingNoteOpen(null as never)).resolves.toBe(false);
		expect('pendingNoteOpen' in storage).toBe(false);
	});

	it('treats a target past its TTL, or a garbage value, as absent', async () => {
		storage = { pendingNoteOpen: { videoId: 'v1', noteId: 'n1', at: Date.now() - window.YTB.PENDING_NOTE_OPEN_TTL_MS - 1 } };
		await expect(window.YTB.getPendingNoteOpen()).resolves.toBeNull();
		storage = { pendingNoteOpen: 'junk' };
		await expect(window.YTB.getPendingNoteOpen()).resolves.toBeNull();
		storage = { pendingNoteOpen: { videoId: 'v1' } };
		await expect(window.YTB.getPendingNoteOpen()).resolves.toBeNull();
	});

	it('clears the slot idempotently', async () => {
		storage = { pendingNoteOpen: { videoId: 'v1', noteId: 'n1', at: Date.now() } };
		await window.YTB.clearPendingNoteOpen();
		await expect(window.YTB.getPendingNoteOpen()).resolves.toBeNull();
		await window.YTB.clearPendingNoteOpen(); // idempotent
		await expect(window.YTB.getPendingNoteOpen()).resolves.toBeNull();
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
			recommendedForYou(
				playlist: Array<{ videoId: string; addedBy: string; addedAt: number }> | undefined,
				myClientId: string,
				dismissedVideoIds?: Iterable<string>,
			): Array<{ videoId: string; addedBy: string; addedAt: number }>;
			dismissedVideoIds(code: string): Promise<string[]>;
			dismissVideo(code: string, videoId: string): Promise<string[]>;
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
			noteLinkTooltip(note: { videoTitle?: string; timestamp: number }): string;
			titleLinkTooltip(title: string | null): string;
			watchedByLabel(progress: object[], videoId: string, myClientId: string, roster?: Array<{ clientId: string; name?: string }>): string;
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
			getRecords(code: string): Promise<{ notes: object[]; replies: object[]; playlist?: object[]; events?: object[]; ok: boolean }>;
			getHomeSectionHidden(): Promise<boolean>;
			setHomeSectionHidden(hidden: boolean): Promise<boolean>;
			PENDING_NOTE_OPEN_TTL_MS: number;
			PANEL_LOAD_GRACE_MS: number;
			panelPlayAction(state: { panelOpen: boolean; withinGrace: boolean }): 'ignore' | 'hold' | 'dismiss';
			setPendingNoteOpen(target: { videoId: string; noteId: string }): Promise<boolean>;
			getPendingNoteOpen(): Promise<{ videoId: string; noteId: string; at: number } | null>;
			clearPendingNoteOpen(): Promise<boolean>;
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
			relativeTime(thenMs: number, nowMs?: number): string;
			errorCopy(category: string, action: 'note' | 'reply' | 'reaction'): string;
			crossedNotes<T extends { timestamp: number }>(notes: T[], previousTime: number, currentTime: number): T[];
			dotActivation(note: { kind?: string; spoiler?: boolean; timestamp?: number }): { action: 'open' };
			notePanelVariant(note: { kind?: string; spoiler?: boolean; timestamp?: number }, playhead: number): 'text' | 'reaction' | 'spoiler';
			nearNoteMoment(timestamp: number, playhead: number): boolean;
		};
	}
}
