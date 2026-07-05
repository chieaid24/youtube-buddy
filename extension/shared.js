// extension/shared.js
//
// The `window.YTB` global: backend URL, config storage helpers, the API client,
// and formatting utils. Loaded by BOTH the popup (<script src="shared.js"> before
// popup.js) and as the FIRST content-script file, so every helper must work in
// both contexts (popups and content scripts both have chrome.storage + fetch).
//
// Content scripts are NOT ES modules — this file communicates only via the
// `window.YTB` global, no import/export. See ADR-0001.
//
// `code` ownership (decided once, depended on by tasks 04 and 05):
//   - getRecords(code)  — code is PASSED IN (the popup already holds the code).
//   - postProgress(...) — code is READ FROM CONFIG (the reporter just wants to
//                         "send my current position"; it never carries the code).
// Room Codes are stored already-normalized (popup calls normalizeCode before
// setConfig), so the API client passes the code through verbatim.

const YTB = {
	// A Chrome extension reload/update leaves already-injected content scripts in
	// the page, but revokes their access to extension APIs. Treat that one error
	// as a terminal lifecycle event for the stale script. Popup documents are
	// destroyed by Chrome, so the same helpers are harmless there.
	_contextActive: true,
	_contextInvalidationCallbacks: new Set(),

	isExtensionContextInvalidation(error) {
		return /extension context invalidated/i.test(String(error && error.message ? error.message : error));
	},

	isContextActive() {
		return YTB._contextActive;
	},

	onContextInvalidated(callback) {
		if (!YTB._contextActive) {
			callback();
			return () => {};
		}
		YTB._contextInvalidationCallbacks.add(callback);
		return () => YTB._contextInvalidationCallbacks.delete(callback);
	},

	_handleContextInvalidation(error) {
		if (!YTB.isExtensionContextInvalidation(error)) return false;
		if (!YTB._contextActive) return true;
		YTB._contextActive = false;
		let callbackError;
		for (const callback of YTB._contextInvalidationCallbacks) {
			try {
				callback();
			} catch (error) {
				callbackError ||= error;
			}
		}
		YTB._contextInvalidationCallbacks.clear();
		if (callbackError) throw callbackError;
		return true;
	},

	async _storageGet(keys) {
		if (!YTB._contextActive) return {};
		try {
			return await chrome.storage.local.get(keys);
		} catch (error) {
			if (YTB._handleContextInvalidation(error)) return {};
			throw error;
		}
	},

	async _storageSet(values) {
		if (!YTB._contextActive) return false;
		try {
			await chrome.storage.local.set(values);
			return true;
		} catch (error) {
			if (YTB._handleContextInvalidation(error)) return false;
			throw error;
		}
	},

	// --- config ---
	// PLACEHOLDER backend URL — replace with the deployed …workers.dev URL from
	// task 02 (also update the matching entry in manifest.json host_permissions).
	BACKEND_URL: 'http://localhost:8787',

	// A Room Code is one Room of at most this many distinct Client IDs (you +
	// up to 4 Buddies). Mirrors MAX_MEMBERS in the backend Worker; the server
	// enforces it, the client uses it to detect a full Room (see roomView).
	MAX_MEMBERS: 5,

	// Keep this literal in lockstep with backend NOTE_EMOJIS. The backend rejects
	// any emoji outside this deliberately small Reaction set.
	NOTE_EMOJIS: ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}'],

	// Mirrors the backend caps: a text Note or Reply is at most this long, and a
	// Note conversation holds at most this many Replies (best-effort under KV).
	NOTE_MAX_CHARS: 100,
	MAX_REPLIES: 10,

	// Two timeline dots whose timestamps fall within this window would overlap;
	// spreadFractions separates them. Mirrored by the Playback Notification
	// "natural crossing" delta in notes.js.
	SPREAD_WINDOW_SECONDS: 2,

	// --- storage (chrome.storage.local) ---
	// Stored keys: name, code, clientId, sharing, and Room-scoped buddyColors.

	/**
	 * Read the full config, applying defaults for unset keys.
	 * `clientId` is "" until ensureClientId() has minted one — call that when you
	 * need a guaranteed id.
	 * @returns {Promise<{name: string, code: string, clientId: string, sharing: boolean}>}
	 */
	async getConfig() {
		const stored = await YTB._storageGet(['name', 'code', 'clientId', 'sharing']);
		return {
			name: stored.name ?? '',
			code: stored.code ?? '',
			clientId: stored.clientId ?? '',
			sharing: stored.sharing ?? true,
		};
	},

	/**
	 * Merge-write a subset of { name, code, sharing } into
	 * chrome.storage.local. `clientId` is intentionally NOT writable here — it is
	 * owned by ensureClientId.
	 * @param {{name?: string, code?: string, sharing?: boolean}} partial
	 */
	async setConfig(partial) {
		const next = {};
		for (const key of ['name', 'code', 'sharing']) {
			if (key in partial) next[key] = partial[key];
		}
		await YTB._storageSet(next);
	},

	/**
	 * Return the existing Client ID, or mint one ONCE (8 hex chars) and persist it.
	 * Stable for the life of the install.
	 * @returns {Promise<string>}
	 */
	async ensureClientId() {
		const { clientId } = await YTB._storageGet('clientId');
		if (clientId) return clientId;
		if (!YTB.isContextActive()) return '';
		const bytes = new Uint8Array(4); // 4 bytes -> 8 hex chars
		crypto.getRandomValues(bytes);
		const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		await YTB._storageSet({ clientId: id });
		return id;
	},

	// --- API client (talks to BACKEND_URL; wire format defined in task 01) ---

	/**
	 * POST this user's current Progress Record. Reads the Room Code from config.
	 * Body is exactly the 5 fields below (no updatedAt — the server sets it).
	 * Tolerates failure silently per the PRD's "minimal error handling": resolves
	 * to { ok: true } on success, or false on missing code / network / non-2xx.
	 * @param {{clientId: string, name: string, videoId: string, timestamp: number, duration: number}} record
	 * @returns {Promise<{ok: true}|false>}
	 */
	async postProgress({ clientId, name, videoId, timestamp, duration }) {
		const { code } = await YTB.getConfig();
		if (!code) return false; // Unpaired — nothing to share.
		try {
			const res = await fetch(YTB.BACKEND_URL + '/?code=' + encodeURIComponent(code), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					clientId,
					name,
					videoId,
					timestamp,
					duration,
				}),
			});
			return res.ok ? { ok: true } : false;
		} catch {
			return false;
		}
	},

	/**
	 * GET everything live under `code`: Progress Records AND presence rows (mine
	 * AND the Buddies' — the server does no filtering; consumers split by comparing
	 * clientId). The server returns `{ progress, presence }`; on any failure this
	 * resolves to empty arrays so callers never have to null-check.
	 * @param {string} code Room Code (already normalized).
	 * @returns {Promise<{progress: Array<{clientId: string, name: string, videoId: string, timestamp: number, duration: number, updatedAt: number}>, presence: Array<{clientId: string, name: string, updatedAt: number}>, notes: Array<{id: string, clientId: string, name: string, videoId: string, timestamp: number, kind: string, body: string, spoiler: boolean, createdAt: number}>}>}
	 */
	async getRecords(code) {
		const empty = {
			progress: [],
			presence: [],
			notes: [],
			replies: [],
			ok: false,
		};
		try {
			const res = await fetch(YTB.BACKEND_URL + '/?code=' + encodeURIComponent(code));
			if (!res.ok) {
				// Minimal error handling by design (see PRD): we still render nothing this
				// cycle, but a non-2xx must not vanish silently — an unlogged GET failure
				// is a total Buddy blackout (no markers, no thumbnail bars) with no trace.
				console.warn('[youtube-buddy] getRecords: backend GET returned HTTP', res.status, '- rendering no Buddies this cycle');
				return empty;
			}
			const data = await res.json();
			return {
				progress: Array.isArray(data && data.progress) ? data.progress : [],
				presence: Array.isArray(data && data.presence) ? data.presence : [],
				notes: Array.isArray(data && data.notes) ? data.notes : [],
				replies: Array.isArray(data && data.replies) ? data.replies : [],
				ok: true,
			};
		} catch (err) {
			// Network drop or malformed JSON - same silent-blackout risk as a non-2xx.
			console.warn('[youtube-buddy] getRecords: backend GET failed -', err);
			return empty;
		}
	},

	/** Delete one of this install's Notes. Best-effort and ownership-checked by the server. */
	async deleteNote(code, clientId, id) {
		if (!code || !clientId || !id) return false;
		try {
			const query = new URLSearchParams({ code, clientId, id });
			const res = await fetch(YTB.BACKEND_URL + '/notes?' + query, {
				method: 'DELETE',
			});
			return res.ok ? { ok: true } : false;
		} catch {
			return false;
		}
	},

	/**
	 * POST a JSON payload and normalize the outcome: `{ ok: true, ...body }` on
	 * success, else `{ ok: false, category }` with the server's machine-readable
	 * error category ('unexpected' for network failures / unparseable bodies).
	 * Callers branch on `category`, never on prose.
	 */
	async _postJson(pathAndQuery, payload) {
		try {
			const res = await fetch(YTB.BACKEND_URL + pathAndQuery, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const data = await res.json().catch(() => null);
			if (res.ok) return { ok: true, ...(data || {}) };
			return { ok: false, category: (data && data.category) || 'unexpected' };
		} catch {
			return { ok: false, category: 'unexpected' };
		}
	},

	/**
	 * Post a text Note or curated-emoji Reaction at a playback position.
	 * Resolves to `{ ok: true, note }` carrying the COMPLETE server-authoritative
	 * record (insert it into the active Video Timeline immediately), or
	 * `{ ok: false, category }`. Sharing gates all writes client-side.
	 * @returns {Promise<{ok: true, note: object}|{ok: false, category: string}>}
	 */
	async postNote({ clientId, name, videoId, timestamp, kind, body, spoiler }) {
		const { code, sharing } = await YTB.getConfig();
		if (!code || !sharing) return { ok: false, category: 'sharing_off' };
		return YTB._postJson('/notes?code=' + encodeURIComponent(code), {
			clientId,
			name,
			videoId,
			timestamp,
			kind,
			body,
			spoiler,
		});
	},

	/**
	 * Post a Reply to an existing text Note. Resolves to `{ ok: true, reply }`
	 * with the complete server record (append it to the open conversation), or
	 * `{ ok: false, category }` — notably 'reply_cap', 'missing_parent',
	 * 'room_full', or 'sharing_off'.
	 * @returns {Promise<{ok: true, reply: object}|{ok: false, category: string}>}
	 */
	async postReply({ clientId, name, noteId, body }) {
		const { code, sharing } = await YTB.getConfig();
		if (!code || !sharing) return { ok: false, category: 'sharing_off' };
		return YTB._postJson('/replies?code=' + encodeURIComponent(code), {
			clientId,
			name,
			noteId,
			body,
		});
	},

	/**
	 * Focused conversation read for an open Expanded Note: one parent Note plus
	 * its Replies oldest-first, cheap enough to poll every 5 seconds without
	 * pulling the whole Room. `{ ok: false, category: 'missing_parent' }` means
	 * the Note was deleted while open.
	 * @returns {Promise<{ok: true, note: object, replies: Array<object>}|{ok: false, category: string}>}
	 */
	async getConversation(code, noteId) {
		if (!code || !noteId) return { ok: false, category: 'validation' };
		try {
			const query = new URLSearchParams({ code, noteId });
			const res = await fetch(YTB.BACKEND_URL + '/conversation?' + query);
			const data = await res.json().catch(() => null);
			if (res.ok && data && data.note) {
				return {
					ok: true,
					note: data.note,
					replies: Array.isArray(data.replies) ? data.replies : [],
				};
			}
			return { ok: false, category: (data && data.category) || 'unexpected' };
		} catch {
			return { ok: false, category: 'unexpected' };
		}
	},

	/**
	 * Announce "I'm here" under `code` — a presence row independent of watching and
	 * of the Sharing toggle. Idempotent upsert (the server refreshes updatedAt +
	 * TTL), so it doubles as a keep-alive and a backfill for pre-presence installs.
	 * Best-effort: resolves { ok: true } on success, false otherwise.
	 * @param {string} code Room Code (already normalized).
	 * @returns {Promise<{ok: true}|false>}
	 */
	async assertPresence(code) {
		if (!code) return false; // Unpaired — nobody to appear to.
		const { name } = await YTB.getConfig();
		const clientId = await YTB.ensureClientId();
		if (!YTB.isContextActive()) return false;
		try {
			const res = await fetch(YTB.BACKEND_URL + '/presence?code=' + encodeURIComponent(code), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ clientId, name }),
			});
			return res.ok ? { ok: true } : false;
		} catch {
			return false;
		}
	},

	/**
	 * Remove my membership from `code`, including presence and every Progress
	 * Record. Idempotent on the server. Best-effort — on failure records TTL out.
	 * @param {string} code Room Code (already normalized).
	 * @param {string} clientId
	 * @returns {Promise<{ok: true}|false>}
	 */
	async deleteMember(code, clientId) {
		if (!code || !clientId) return false;
		try {
			const res = await fetch(YTB.BACKEND_URL + '/member?code=' + encodeURIComponent(code) + '&clientId=' + encodeURIComponent(clientId), {
				method: 'DELETE',
			});
			return res.ok ? { ok: true } : false;
		} catch {
			return false;
		}
	},

	// --- utils ---

	/**
	 * Format seconds as "M:SS" (or "H:MM:SS" past an hour) for tooltips.
	 * e.g. 412 -> "6:52".
	 * @param {number} seconds
	 * @returns {string}
	 */
	formatTime(seconds) {
		const total = Math.max(0, Math.floor(Number(seconds) || 0));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const ss = String(s).padStart(2, '0');
		if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
		return `${m}:${ss}`;
	},

	/**
	 * Relative age label for a creation time: "just now", "8 min ago",
	 * "1 hr ago", "4 days ago", "1 week ago" — rounded DOWN to the largest
	 * useful unit, progressing to months after four weeks and to years after
	 * twelve months. UI copy prefixes "Posted ".
	 * @param {number} thenMs epoch millis (server createdAt)
	 * @param {number} [nowMs]
	 * @returns {string}
	 */
	relativeTime(thenMs, nowMs = Date.now()) {
		const seconds = Math.max(0, Math.floor((nowMs - Number(thenMs)) / 1000));
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} hr ago`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
		const weeks = Math.floor(days / 7);
		if (weeks < 4) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
		const months = Math.max(1, Math.floor(days / 30));
		if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
		const years = Math.floor(days / 365);
		return `${years} year${years === 1 ? '' : 's'} ago`;
	},

	/**
	 * User-facing copy for a failed Note/Reply/Reaction write, keyed by the
	 * server's machine-readable category. Known safe cases get specific copy;
	 * everything else gets the action's generic retry message. Never surfaces
	 * backend prose.
	 * @param {string} category
	 * @param {'note'|'reply'|'reaction'} action
	 * @returns {string}
	 */
	errorCopy(category, action) {
		if (category === 'reply_cap') return 'This note already has 10 replies.';
		if (category === 'room_full') return "This Room is full, so you can't post here.";
		if (category === 'missing_parent') return 'This note is no longer available.';
		return `We couldn't post your ${action}. Try again.`;
	},

	/**
	 * Spread timeline dots that would overlap. Dots whose timestamps chain
	 * within SPREAD_WINDOW_SECONDS form a group; each group is spread
	 * horizontally by `minGap` around its natural center — chronological order
	 * preserved, clamped inside [0,1] — so every dot keeps a separate pointer
	 * and keyboard target. Dots are never merged and their true timestamps are
	 * untouched (this maps ids to DISPLAY fractions only).
	 * @param {Array<{id: string, timestamp: number, fraction: number}>} dots
	 * @param {number} [minGap] minimum separation as a fraction of the bar
	 * @returns {Map<string, number>} id -> display fraction
	 */
	spreadFractions(dots, minGap = 0.012) {
		const sorted = [...dots].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
		const out = new Map();
		let group = [];
		const flush = () => {
			if (group.length === 0) return;
			if (group.length === 1) {
				out.set(group[0].id, group[0].fraction);
			} else {
				const span = (group.length - 1) * minGap;
				const center = group.reduce((sum, dot) => sum + dot.fraction, 0) / group.length;
				const start = Math.max(0, Math.min(center - span / 2, 1 - span));
				group.forEach((dot, i) => out.set(dot.id, start + i * minGap));
			}
			group = [];
		};
		for (const dot of sorted) {
			if (group.length > 0 && dot.timestamp - group[group.length - 1].timestamp > YTB.SPREAD_WINDOW_SECONDS) flush();
			group.push(dot);
		}
		flush();
		return out;
	},

	/**
	 * The Notes whose timestamps ordinary forward playback just crossed:
	 * previousTime < timestamp <= currentTime, in timestamp order. The CALLER
	 * decides whether the step was natural (small forward delta, not a seek);
	 * this stays a pure filter so every natural crossing — including replays
	 * after rewinding — triggers again.
	 * @param {Array<{timestamp: number}>} notes
	 * @param {number} previousTime
	 * @param {number} currentTime
	 * @returns {Array<object>}
	 */
	crossedNotes(notes, previousTime, currentTime) {
		return (notes || [])
			.filter((note) => {
				const t = Number(note.timestamp);
				return Number.isFinite(t) && t > previousTime && t <= currentTime;
			})
			.sort((a, b) => a.timestamp - b.timestamp);
	},

	/**
	 * Normalize a Room Code to its canonical slug so the pretty label and the
	 * typed/pasted form both pair. Lowercases, drops a leading "the ", turns runs
	 * of whitespace into single hyphens, and collapses/trims stray hyphens. So
	 * "The Silly Otters", "silly otters", and "silly-otters" all → "silly-otters".
	 * @param {string} raw
	 * @returns {string}
	 */
	normalizeCode(raw) {
		return String(raw ?? '')
			.trim()
			.toLowerCase()
			.replace(/^the\s+/, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');
	},

	// --- Room helpers (multiple Buddies) ---

	/** Return whether a Room has ever had at least one member record. */
	roomExists(records) {
		return (records?.progress?.length || 0) + (records?.presence?.length || 0) > 0;
	},

	// Fixed colors chosen for contrast on light popup/feed surfaces and YouTube's
	// dark player. A Room has at most four foreign Buddies, leaving spare choices.
	BUDDY_COLORS: ['#00a6d6', '#f0a500', '#7655d6', '#00a86b', '#e85d04', '#d936c7', '#558b2f', '#4776e6'],
	_buddyColors: {},
	_activeRoomCode: '',

	async syncBuddyColors(code, buddyIds, successful, random = Math.random) {
		const stored = await YTB._storageGet('buddyColors');
		if (!YTB.isContextActive()) return {};
		const all = stored.buddyColors || {};
		const room = { ...(all[code] || {}) };
		if (successful) {
			const current = new Set(buddyIds);
			for (const id of Object.keys(room)) if (!current.has(id)) delete room[id];
			for (const id of buddyIds) {
				if (room[id]) continue;
				const used = new Set(Object.values(room));
				const available = YTB.BUDDY_COLORS.filter((color) => !used.has(color));
				room[id] = available[Math.floor(random() * available.length)];
			}
			all[code] = room;
			await YTB._storageSet({ buddyColors: all });
		}
		YTB._buddyColors = all;
		YTB._activeRoomCode = code;
		return room;
	},

	async setBuddyColor(code, clientId, color) {
		if (!YTB.BUDDY_COLORS.includes(color)) return false;
		const stored = await YTB._storageGet('buddyColors');
		if (!YTB.isContextActive()) return false;
		const all = stored.buddyColors || {};
		const room = { ...(all[code] || {}) };
		if (Object.entries(room).some(([id, assigned]) => id !== clientId && assigned === color)) return false;
		room[clientId] = color;
		all[code] = room;
		YTB._buddyColors = all;
		YTB._activeRoomCode = code;
		await YTB._storageSet({ buddyColors: all });
		return true;
	},

	async clearRoomColors(code) {
		const stored = await YTB._storageGet('buddyColors');
		if (!YTB.isContextActive()) return;
		const all = stored.buddyColors || {};
		delete all[code];
		YTB._buddyColors = all;
		await YTB._storageSet({ buddyColors: all });
	},

	// Playful adjectives for unnamed Buddies (see buddyName). 16 entries spread
	// unnamed Buddies across the small set ever on screen.
	ADJECTIVES: [
		'Silly',
		'Scary',
		'Sleepy',
		'Sneaky',
		'Grumpy',
		'Goofy',
		'Wild',
		'Brave',
		'Cheeky',
		'Jolly',
		'Mighty',
		'Sloppy',
		'Spooky',
		'Zesty',
		'Snazzy',
		'Wobbly',
	],

	/**
	 * Stable 32-bit hash of a Client ID. The SAME id always hashes the same, so
	 * everything keyed off a Buddy (their color, their fallback name) stays
	 * stable across videos, thumbnails, the popup, and every viewer.
	 * @param {string} clientId
	 * @returns {number}
	 */
	hashClientId(clientId) {
		const s = String(clientId);
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
		return h;
	},

	/**
	 * Return the viewer-local assignment for a Buddy in a Room.
	 * @param {string} clientId
	 * @param {string} [code]
	 * @returns {string} a hex color
	 */
	buddyColor(clientId, code = YTB._activeRoomCode) {
		return (YTB._buddyColors[code] || {})[clientId] || YTB.BUDDY_COLORS[0];
	},

	/**
	 * Display label for a Buddy. Returns their trimmed Display Name when set, else
	 * a stable "<Adjective> Buddy" derived from their Client ID — same adjective
	 * on every surface and for every viewer (Display Name is optional, so unnamed
	 * Buddies still get a friendly, consistent token). Applies to FOREIGN records
	 * only; you never render yourself as a Buddy.
	 * @param {string} clientId
	 * @param {string} [name]
	 * @returns {string}
	 */
	buddyName(clientId, name) {
		const trimmed = String(name ?? '').trim();
		if (trimmed) return trimmed;
		const adjs = YTB.ADJECTIVES;
		const h = YTB.hashClientId(clientId);
		return `${adjs[((h % adjs.length) + adjs.length) % adjs.length]} Buddy`;
	},

	/**
	 * Reduce the structured `{ progress, presence, notes }` records (mine AND the
	 * Buddies') into a Room view from my perspective. A Buddy is any FOREIGN
	 * clientId appearing in any set: their latest Progress Record (carries a
	 * position) is preferred, else their presence row ("joined", no position). The
	 * Room is capped at MAX_MEMBERS distinct Client IDs across all three sets.
	 * @param {{progress: Array<object>, presence: Array<object>, notes?: Array<object>}} records
	 * @param {string} myClientId
	 * @returns {{buddies: Array<object>, iAmMember: boolean, locked: boolean}}
	 *   buddies — one entry per distinct foreign Buddy, newest-first by updatedAt.
	 *   iAmMember — I appear in either set under the code.
	 *   locked — the Room is full of OTHERS and I am not one of them (would be the
	 *            rejected 6th): render nothing, show "Room full".
	 */
	roomView(records, myClientId) {
		const progress = (records && records.progress) || [];
		const presence = (records && records.presence) || [];
		const notes = (records && records.notes) || [];

		const latestByBuddy = new Map(); // clientId -> latest progress record
		const presenceByBuddy = new Map(); // clientId -> presence row
		const noteByBuddy = new Map(); // clientId -> latest Note
		const memberIds = new Set(); // distinct clientIds across all sets (for the cap)
		let iAmMember = false;

		for (const r of progress) {
			if (!r || !r.clientId) continue;
			memberIds.add(r.clientId);
			if (r.clientId === myClientId) {
				iAmMember = true;
				continue;
			}
			const prev = latestByBuddy.get(r.clientId);
			if (!prev || r.updatedAt > prev.updatedAt) latestByBuddy.set(r.clientId, r);
		}
		for (const p of presence) {
			if (!p || !p.clientId) continue;
			memberIds.add(p.clientId);
			if (p.clientId === myClientId) {
				iAmMember = true;
				continue;
			}
			presenceByBuddy.set(p.clientId, p);
		}
		for (const note of notes) {
			if (!note || !note.clientId) continue;
			memberIds.add(note.clientId);
			if (note.clientId === myClientId) {
				iAmMember = true;
				continue;
			}
			const prev = noteByBuddy.get(note.clientId);
			if (!prev || note.createdAt > prev.createdAt) noteByBuddy.set(note.clientId, note);
		}

		// One entry per foreign Buddy: prefer their progress record (has a position),
		// else a presence-only row (joined, no videoId/timestamp).
		const buddyIds = new Set([...latestByBuddy.keys(), ...presenceByBuddy.keys(), ...noteByBuddy.keys()]);
		const buddies = [];
		for (const cid of buddyIds) {
			const prog = latestByBuddy.get(cid);
			if (prog) {
				buddies.push(prog);
			} else if (presenceByBuddy.has(cid)) {
				const p = presenceByBuddy.get(cid);
				buddies.push({
					clientId: p.clientId,
					name: p.name,
					updatedAt: p.updatedAt,
				});
			} else {
				const note = noteByBuddy.get(cid);
				buddies.push({
					clientId: note.clientId,
					name: note.name,
					updatedAt: note.createdAt,
				});
			}
		}
		buddies.sort((a, b) => b.updatedAt - a.updatedAt);

		// Distinct OTHERS; 5 of them with no membership of my own = a full Room I'd
		// be the locked-out 6th of.
		let foreignCount = 0;
		for (const id of memberIds) if (id !== myClientId) foreignCount++;
		const locked = !iAmMember && foreignCount >= YTB.MAX_MEMBERS;

		return { buddies, iAmMember, locked };
	},
};

window.YTB = YTB;
