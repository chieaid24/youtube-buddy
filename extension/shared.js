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
	// --- config ---
	// PLACEHOLDER backend URL — replace with the deployed …workers.dev URL from
	// task 02 (also update the matching entry in manifest.json host_permissions).
	BACKEND_URL: 'http://localhost:8787',

	// A Room Code is one Room of at most this many distinct Client IDs (you +
	// up to 4 Buddies). Mirrors MAX_MEMBERS in the backend Worker; the server
	// enforces it, the client uses it to detect a full Room (see roomView).
	MAX_MEMBERS: 5,

	// --- storage (chrome.storage.local) ---
	// Stored keys: name (Display Name), code (Room Code), clientId, sharing
	// (boolean), palette (buddy color theme name; local render preference,
	// default "default").

	/**
	 * Read the full config, applying defaults for unset keys.
	 * `clientId` is "" until ensureClientId() has minted one — call that when you
	 * need a guaranteed id.
	 * @returns {Promise<{name: string, code: string, clientId: string, sharing: boolean, palette: string}>}
	 */
	async getConfig() {
		const stored = await chrome.storage.local.get(['name', 'code', 'clientId', 'sharing', 'palette']);
		return {
			name: stored.name ?? '',
			code: stored.code ?? '',
			clientId: stored.clientId ?? '',
			sharing: stored.sharing ?? true,
			palette: stored.palette ?? 'default',
		};
	},

	/**
	 * Merge-write a subset of { name, code, sharing, palette } into
	 * chrome.storage.local. `clientId` is intentionally NOT writable here — it is
	 * owned by ensureClientId.
	 * @param {{name?: string, code?: string, sharing?: boolean, palette?: string}} partial
	 */
	async setConfig(partial) {
		const next = {};
		for (const key of ['name', 'code', 'sharing', 'palette']) {
			if (key in partial) next[key] = partial[key];
		}
		await chrome.storage.local.set(next);
	},

	/**
	 * Return the existing Client ID, or mint one ONCE (8 hex chars) and persist it.
	 * Stable for the life of the install.
	 * @returns {Promise<string>}
	 */
	async ensureClientId() {
		const { clientId } = await chrome.storage.local.get('clientId');
		if (clientId) return clientId;
		const bytes = new Uint8Array(4); // 4 bytes -> 8 hex chars
		crypto.getRandomValues(bytes);
		const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		await chrome.storage.local.set({ clientId: id });
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
	 * @returns {Promise<{progress: Array<{clientId: string, name: string, videoId: string, timestamp: number, duration: number, updatedAt: number}>, presence: Array<{clientId: string, name: string, updatedAt: number}>}>}
	 */
	async getRecords(code) {
		const empty = { progress: [], presence: [] };
		try {
			const res = await fetch(YTB.BACKEND_URL + '/?code=' + encodeURIComponent(code));
			if (!res.ok) return empty;
			const data = await res.json();
			return {
				progress: Array.isArray(data && data.progress) ? data.progress : [],
				presence: Array.isArray(data && data.presence) ? data.presence : [],
			};
		} catch {
			return empty;
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

	// Marker color palettes. Each is >= 5 visually distinct colors, all clear of
	// YouTube's red watched-bar. `default` is tuned for high contrast on the dark
	// player and bright thumbnails (every user gets it out of the box); the rest
	// are opt-in themes, a purely LOCAL render preference (config `palette`). A
	// Room holds <= MAX_MEMBERS, so up to 4 Buddies ever need a color at once.
	PALETTES: {
		default: ['#00d2ff', '#ffc400', '#8c5bff', '#00e08a', '#ff7a00', '#ff3df5'],
		tropical: ['#ff8c42', '#ffd23f', '#2ec4b6', '#06d6a0', '#ff5db1', '#9b5de5'],
		cool: ['#56cfe1', '#4ea8de', '#5e60ce', '#7400b8', '#64dfdf', '#80ffdb'],
		pastel: ['#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff'],
	},

	// Cached active palette NAME for the synchronous buddyColor(). Each context
	// (popup, content script) seeds this from config on load and refreshes it on a
	// chrome.storage change; a stale read just costs one render in the old palette.
	_activePalette: 'default',

	// Resolve a palette name to its color array, falling back to `default`.
	paletteColors(name) {
		return YTB.PALETTES[name] || YTB.PALETTES.default;
	},

	// Playful adjectives for unnamed Buddies (see buddyName). 16 entries spread
	// unnamed Buddies across the small set ever on screen, and stay independent of
	// the color palette so two unnamed Buddies rarely share BOTH adjective + color.
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
	 * Stable color for a Buddy, hashed from their Client ID — within a palette the
	 * SAME friend is the SAME color on every video, thumbnail, and the popup
	 * roster, regardless of who else is in the Room. Pass `paletteName` to force a
	 * palette (e.g. the popup's live preview); omit it to read the cached active
	 * palette (YTB._activePalette). Switching palette recolors everyone but keeps
	 * each Buddy's slot. More Buddies than palette entries can collide; tooltips
	 * and the popup roster still disambiguate (accepted tradeoff).
	 * @param {string} clientId
	 * @param {string} [paletteName]
	 * @returns {string} a hex color
	 */
	buddyColor(clientId, paletteName) {
		const palette = YTB.paletteColors(paletteName || YTB._activePalette);
		const h = YTB.hashClientId(clientId);
		return palette[((h % palette.length) + palette.length) % palette.length];
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
	 * Reduce the structured `{ progress, presence }` records (mine AND the
	 * Buddies') into a Room view from my perspective. A Buddy is any FOREIGN
	 * clientId appearing in EITHER set: their latest Progress Record (carries a
	 * position) is preferred, else their presence row ("joined", no position). The
	 * Room is capped at MAX_MEMBERS distinct Client IDs across both sets.
	 * @param {{progress: Array<object>, presence: Array<object>}} records
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

		const latestByBuddy = new Map(); // clientId -> latest progress record
		const presenceByBuddy = new Map(); // clientId -> presence row
		const memberIds = new Set(); // distinct clientIds across BOTH sets (for the cap)
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

		// One entry per foreign Buddy: prefer their progress record (has a position),
		// else a presence-only row (joined, no videoId/timestamp).
		const buddyIds = new Set([...latestByBuddy.keys(), ...presenceByBuddy.keys()]);
		const buddies = [];
		for (const cid of buddyIds) {
			const prog = latestByBuddy.get(cid);
			if (prog) {
				buddies.push(prog);
			} else {
				const p = presenceByBuddy.get(cid);
				buddies.push({
					clientId: p.clientId,
					name: p.name,
					updatedAt: p.updatedAt,
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
