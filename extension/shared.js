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

	// Mirrors the backend cap: the Room's Recommendation list holds at most
	// this many distinct videos (API/KV names keep the playlist term, ADR-0007).
	MAX_PLAYLIST_ITEMS: 30,

	// The Expanded Note omits "Go here" when the paused playhead already sits
	// within this many seconds of the Note's moment (nearNoteMoment) — there is
	// nowhere meaningful to go. Independent of the Playback Notification
	// "natural crossing" delta in notes.js.
	GO_HERE_NEAR_SECONDS: 2,

	// --- storage (chrome.storage.local) ---
	// Stored keys: name, code, clientId, sharing, homeSectionHidden, the Settings
	// keys (theme, spoilerDefault, notificationPosition, notesHidden,
	// buddyProgressHidden), and the Room-scoped buddyColors + dismissedVideos +
	// seenItems maps.

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
	 * Whether the viewer turned the Room Home Section off with the Room Home
	 * Toggle. Per install (NOT Room-scoped), absent means visible.
	 * @returns {Promise<boolean>}
	 */
	async getHomeSectionHidden() {
		const { homeSectionHidden } = await YTB._storageGet('homeSectionHidden');
		return homeSectionHidden === true;
	},

	/**
	 * Persist the Room Home Toggle state. Coerced to a strict boolean so the
	 * stored value round-trips getHomeSectionHidden exactly.
	 * @param {boolean} hidden
	 * @returns {Promise<boolean>} false when the extension context is gone.
	 */
	async setHomeSectionHidden(hidden) {
		return await YTB._storageSet({ homeSectionHidden: hidden === true });
	},

	// A clicked Room Feed reply/mention row lives on the home route; the Note it
	// points at is rendered by notes.js on the watch route. The two surfaces
	// hand off through this single storage slot: the row records the target, and
	// notes.js consumes it on the first Room read after arrival to open the
	// Expanded Note. Storage (not just an in-memory event) so the handshake
	// survives BOTH an SPA navigation — where the content scripts stay alive per
	// ADR-0001 — and a full page reload. The TTL keeps a stale target (an
	// abandoned click, a deleted Note) from popping a panel on a later visit.
	PENDING_NOTE_OPEN_TTL_MS: 30_000,

	// How long after a Room-Feed-initiated Expanded Note open notes.js treats a
	// video `play` as load-time churn (the watch page's autoplay kicking in as it
	// settles) rather than the viewer's deliberate resume: during this window the
	// panel is kept open and the video re-paused; afterwards a play dismisses it
	// as usual. Long enough to outlast autoplay-on-arrival, short enough not to
	// swallow a real later resume. See YTB.panelPlayAction.
	PANEL_LOAD_GRACE_MS: 4_000,

	/**
	 * Record the Note a Room Feed row points at, for notes.js to open after the
	 * navigation to `videoId`. A single slot: a newer click replaces an older
	 * unconsumed one.
	 * @param {{videoId: string, noteId: string}} target
	 * @returns {Promise<boolean>} false when the target is malformed or context is gone.
	 */
	async setPendingNoteOpen(target) {
		const videoId = target && target.videoId ? String(target.videoId) : '';
		const noteId = target && target.noteId ? String(target.noteId) : '';
		if (!videoId || !noteId) return false;
		return await YTB._storageSet({ pendingNoteOpen: { videoId, noteId, at: Date.now() } });
	},

	/**
	 * Read the pending open-target, or null when absent, malformed, or past its
	 * TTL. Never throws on a stale/garbage value.
	 * @returns {Promise<{videoId: string, noteId: string, at: number}|null>}
	 */
	async getPendingNoteOpen() {
		const { pendingNoteOpen } = await YTB._storageGet('pendingNoteOpen');
		if (!pendingNoteOpen || !pendingNoteOpen.videoId || !pendingNoteOpen.noteId) return null;
		if (Date.now() - (Number(pendingNoteOpen.at) || 0) > YTB.PENDING_NOTE_OPEN_TTL_MS) return null;
		return pendingNoteOpen;
	},

	/**
	 * Clear the pending open-target once notes.js has opened its Expanded Note
	 * (or on expiry). Idempotent.
	 * @returns {Promise<boolean>}
	 */
	async clearPendingNoteOpen() {
		return await YTB._storageSet({ pendingNoteOpen: null });
	},

	// --- Settings (per install, chrome.storage.local — mirrors homeSectionHidden) ---

	// The Theme Preference's legal values (ADR-0008/0009). 'light'/'dark' stamp
	// data-theme on the root everywhere. 'system' is the "Auto" option: in the
	// popup it follows the OS via @media (prefers-color-scheme); on a YouTube page
	// it follows YouTube's own theme (see themeMarker below + theme.js).
	THEMES: ['light', 'dark', 'system'],

	// The Notification Position's four edges. Playback Notifications render
	// centered along the chosen player edge (notes.js): top/bottom are
	// horizontally centered, left/right vertically centered.
	NOTIFICATION_EDGES: ['top', 'bottom', 'left', 'right'],

	/**
	 * Read every Settings key, coercing unset/junk values to the documented
	 * defaults so consumers never validate: theme 'system', Spoiler Default on,
	 * Notification Position bottom, Notes and Buddy Progress shown.
	 * (The Room Home Section keeps its own getHomeSectionHidden seam above.)
	 * @returns {Promise<{theme: string, spoilerDefault: boolean, notificationPosition: string, notesHidden: boolean, buddyProgressHidden: boolean}>}
	 */
	async getSettings() {
		const stored = await YTB._storageGet(['theme', 'spoilerDefault', 'notificationPosition', 'notesHidden', 'buddyProgressHidden']);
		return {
			theme: YTB.THEMES.includes(stored.theme) ? stored.theme : 'system',
			spoilerDefault: stored.spoilerDefault !== false,
			notificationPosition: YTB.NOTIFICATION_EDGES.includes(stored.notificationPosition) ? stored.notificationPosition : 'bottom',
			notesHidden: stored.notesHidden === true,
			buddyProgressHidden: stored.buddyProgressHidden === true,
		};
	},

	/**
	 * Merge-write a subset of the Settings keys, validating each value so the
	 * stored state always round-trips getSettings exactly (an illegal theme/edge
	 * is dropped; visibility/spoiler flags coerce to strict booleans).
	 * @param {{theme?: string, spoilerDefault?: boolean, notificationPosition?: string, notesHidden?: boolean, buddyProgressHidden?: boolean}} partial
	 * @returns {Promise<boolean>} false when the extension context is gone.
	 */
	async setSettings(partial) {
		const next = {};
		if ('theme' in partial && YTB.THEMES.includes(partial.theme)) next.theme = partial.theme;
		if ('notificationPosition' in partial && YTB.NOTIFICATION_EDGES.includes(partial.notificationPosition)) {
			next.notificationPosition = partial.notificationPosition;
		}
		for (const key of ['spoilerDefault', 'notesHidden', 'buddyProgressHidden']) {
			if (key in partial) next[key] = partial[key] === true;
		}
		return await YTB._storageSet(next);
	},

	/**
	 * The pure Theme Preference -> data-theme marker decision (ADR-0008/0009).
	 * Forced 'light'/'dark' win everywhere. Under Auto ('system', or any
	 * unexpected/absent value) the marker follows the surrounding page: on a
	 * YouTube page `pageDark` is a boolean (from `<html dark>`) and the marker
	 * mirrors it; off-page (the popup, `pageDark === null`) there is nothing to
	 * follow, so the marker is left unset (null) and the OS
	 * @media (prefers-color-scheme) fallback rules.
	 * @param {string} preference stored Theme Preference
	 * @param {boolean|null} pageDark YouTube page darkness, or null off-page (popup)
	 * @returns {'light'|'dark'|null} the data-theme value, or null to leave it unset
	 */
	themeMarker(preference, pageDark) {
		if (preference === 'light' || preference === 'dark') return preference;
		if (pageDark === true) return 'dark';
		if (pageDark === false) return 'light';
		return null;
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
			playlist: [],
			events: [],
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
				playlist: Array.isArray(data && data.playlist) ? data.playlist : [],
				events: Array.isArray(data && data.events) ? data.events : [],
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
	 * `videoTitle` is the video's title captured at post time (see watchTitle);
	 * omitted when the page had none, and never a reason for the post to fail.
	 * @returns {Promise<{ok: true, note: object}|{ok: false, category: string}>}
	 */
	async postNote({ clientId, name, videoId, videoTitle, timestamp, kind, body, spoiler, mentions }) {
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
			...(typeof videoTitle === 'string' && videoTitle !== '' ? { videoTitle } : {}),
			// Mentions are stored Client IDs picked from the roster (ADR-0006).
			// Omitted entirely when empty, keeping the pre-mentions wire format.
			...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
		});
	},

	/**
	 * Post a Reply to an existing text Note. Resolves to `{ ok: true, reply }`
	 * with the complete server record (append it to the open conversation), or
	 * `{ ok: false, category }` — notably 'reply_cap', 'missing_parent',
	 * 'room_full', or 'sharing_off'.
	 * @returns {Promise<{ok: true, reply: object}|{ok: false, category: string}>}
	 */
	async postReply({ clientId, name, noteId, body, mentions }) {
		const { code, sharing } = await YTB.getConfig();
		if (!code || !sharing) return { ok: false, category: 'sharing_off' };
		return YTB._postJson('/replies?code=' + encodeURIComponent(code), {
			clientId,
			name,
			noteId,
			body,
			...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
		});
	},

	/**
	 * Recommend a video to the Room (ADR-0007; the API keeps its playlist
	 * name). Reads the Room Code from config. NOT gated by Sharing:
	 * recommending is an explicit act, not position reporting (Sharing only
	 * covers Progress Records). Re-adding an existing video is a server-side
	 * no-op returning the EXISTING item (its original recommender stands).
	 * Resolves `{ ok: true, item }` with the complete server record, or
	 * `{ ok: false, category }` — notably 'playlist_full' and 'room_full'.
	 * @returns {Promise<{ok: true, item: object}|{ok: false, category: string}>}
	 */
	async postPlaylistAdd({ clientId, name, videoId, title }) {
		const { code } = await YTB.getConfig();
		if (!code) return { ok: false, category: 'unpaired' };
		return YTB._postJson('/playlist?code=' + encodeURIComponent(code), {
			clientId,
			name,
			videoId,
			title,
		});
	},

	/**
	 * Remove one Recommendation for everyone — the un-recommend point delete
	 * (ADR-0007). Idempotent on the server, which stays permissive (any member
	 * may delete); the UI only offers it to the recommender, from the
	 * watch-page pill. Removals emit no Playlist Event. The clientId is the
	 * acting member (a brand-new clientId is still Room-cap gated).
	 * @returns {Promise<{ok: true}|{ok: false, category: string}>}
	 */
	async deletePlaylistItem({ clientId, videoId }) {
		const { code } = await YTB.getConfig();
		if (!code || !clientId || !videoId) return { ok: false, category: 'validation' };
		try {
			const query = new URLSearchParams({ code, clientId, videoId });
			const res = await fetch(YTB.BACKEND_URL + '/playlist?' + query, {
				method: 'DELETE',
			});
			if (res.ok) return { ok: true };
			const data = await res.json().catch(() => null);
			return { ok: false, category: (data && data.category) || 'unexpected' };
		} catch {
			return { ok: false, category: 'unexpected' };
		}
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
	 * Copy for the author-only delete confirmation in the Expanded Note.
	 * Deleting a Note cascades to its whole conversation, so the confirmation
	 * says exactly how many Replies go with it (correct singular/plural).
	 * @param {number} replyCount
	 * @returns {string}
	 */
	deleteConfirmCopy(replyCount) {
		const count = Math.max(0, Math.floor(Number(replyCount) || 0));
		if (count === 0) return 'Really delete it?';
		return `Really delete it? This will also delete ${count === 1 ? '1 reply' : `${count} replies`}.`;
	},

	/**
	 * The playback position "Go here" seeks to: roughly one second BEFORE the
	 * Note's timestamp (clamped at 0), so resuming playback crosses the Note
	 * naturally and its own Playback Notification fires on the crossing.
	 * @param {number} timestamp the Note's video timestamp in seconds
	 * @returns {number}
	 */
	goHereTarget(timestamp) {
		return Math.max(0, (Number(timestamp) || 0) - 1);
	},

	/**
	 * What activating (click/Enter/Space) a Note Dot or Note Preview does — now
	 * one decision for every kind: OPEN its Expanded Note. Timeline activation
	 * never seeks or changes playback (Go here inside the panel is the only seek),
	 * so this stays a pure seam the executor consults, keeping that invariant in
	 * one tested place. The panel it opens is shaped by notePanelVariant.
	 * @param {{kind?: string, spoiler?: boolean, timestamp?: number}} _note
	 * @returns {{action: 'open'}}
	 */
	dotActivation(_note) {
		return { action: 'open' };
	},

	/**
	 * What a video `play` event does to an open Expanded Note — a pure decision so
	 * notes.js stays a thin executor and the load-churn contract is testable. A
	 * play inside the grace window that follows a Room Feed row opening the panel
	 * (the watch page's autoplay starting as it settles, or a duplicate player
	 * spin-up) is 'hold': re-pause and keep the panel open. Any later play is the
	 * viewer's deliberate resume — 'dismiss'. With no panel open it's 'ignore'.
	 * @param {{panelOpen: boolean, withinGrace: boolean}} state
	 * @returns {'ignore'|'hold'|'dismiss'}
	 */
	panelPlayAction({ panelOpen, withinGrace }) {
		if (!panelOpen) return 'ignore';
		return withinGrace ? 'hold' : 'dismiss';
	},

	/**
	 * Which Expanded Note variant a Note opens into at panel-open, given the
	 * viewer's playhead — the pure routing behind the panel's three shapes:
	 * - 'spoiler': a locked Spoiler (spoiler + playhead before its moment) — body
	 *   masked, with conversation/composer/delete withheld until it unlocks;
	 * - 'reaction': an emoji Reaction — read-only emoji with its author;
	 * - 'text': a plain text Note or an UNLOCKED Spoiler — the full conversation.
	 * @param {{kind?: string, spoiler?: boolean, timestamp?: number}} note
	 * @param {number} playhead the viewer's position in seconds (pass Infinity
	 *   when there is no player — nothing can be locked)
	 * @returns {'text'|'reaction'|'spoiler'}
	 */
	notePanelVariant(note, playhead) {
		if (Boolean(note.spoiler) && Number(playhead) < Number(note.timestamp)) return 'spoiler';
		if (note.kind === 'emoji') return 'reaction';
		return 'text';
	},

	/**
	 * Whether the viewer's (paused, panel-open) playhead already sits within
	 * GO_HERE_NEAR_SECONDS of a Note's moment — |playhead - timestamp| <= 2. When
	 * true the Expanded Note omits Go here entirely (every variant): there is
	 * nowhere meaningful to go. A missing/non-finite playhead (no player) is never
	 * near, so Go here shows.
	 * @param {number} timestamp the Note's video timestamp in seconds
	 * @param {number} playhead the viewer's playback position in seconds
	 * @returns {boolean}
	 */
	nearNoteMoment(timestamp, playhead) {
		const head = Number(playhead);
		if (!Number.isFinite(head)) return false;
		return Math.abs(head - Number(timestamp)) <= YTB.GO_HERE_NEAR_SECONDS;
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

	// --- Room Home Section helpers (pure — tested at the shared.js seam) ---

	/**
	 * The Room's current roster derived from one Room read: one entry per
	 * distinct Client ID across every record kind (progress, presence, Notes,
	 * Replies, Playlist Items, Playlist Events), carrying that member's LATEST
	 * nonblank Display Name (display falls back via buddyName). Sorted by most
	 * recent activity, newest first.
	 * @param {{progress?: Array, presence?: Array, notes?: Array, replies?: Array, playlist?: Array, events?: Array}} records
	 * @returns {Array<{clientId: string, name: string}>}
	 */
	roomRoster(records) {
		const byId = new Map(); // clientId -> { clientId, name, nameAt, at }
		const consider = (clientId, name, at) => {
			if (!clientId) return;
			const t = Number(at) || 0;
			let entry = byId.get(clientId);
			if (!entry) {
				entry = { clientId, name: '', nameAt: -1, at: 0 };
				byId.set(clientId, entry);
			}
			if (t > entry.at) entry.at = t;
			// Only a record that CARRIES a name can update the name — Events are
			// nameless and must never blank out a known Display Name.
			if (typeof name === 'string' && name.trim() !== '' && t > entry.nameAt) {
				entry.name = name.trim();
				entry.nameAt = t;
			}
		};
		for (const r of (records && records.progress) || []) consider(r.clientId, r.name, r.updatedAt);
		for (const p of (records && records.presence) || []) consider(p.clientId, p.name, p.updatedAt);
		for (const n of (records && records.notes) || []) consider(n.clientId, n.name, n.createdAt);
		for (const reply of (records && records.replies) || []) consider(reply.clientId, reply.name, reply.createdAt);
		for (const item of (records && records.playlist) || []) consider(item.addedBy, item.addedByName, item.addedAt);
		for (const event of (records && records.events) || []) consider(event.actorClientId, undefined, event.at);
		return [...byId.values()].sort((a, b) => b.at - a.at).map(({ clientId, name }) => ({ clientId, name }));
	},

	/**
	 * Fuzzy-search the roster for the @-mention autocomplete. Matches each
	 * member's display label (buddyName fallback included) case-insensitively:
	 * prefix matches rank first, then substring, then in-order subsequence
	 * ("sly" finds "Silly Buddy"); ties keep roster order. An empty query
	 * returns the whole roster.
	 * @param {Array<{clientId: string, name: string}>} roster
	 * @param {string} query
	 * @returns {Array<{clientId: string, name: string}>}
	 */
	filterRoster(roster, query) {
		const q = String(query ?? '')
			.trim()
			.toLowerCase();
		const isSubsequence = (needle, haystack) => {
			let i = 0;
			for (const ch of haystack) if (ch === needle[i]) i++;
			return i >= needle.length;
		};
		const scored = [];
		(roster || []).forEach((member, index) => {
			const label = YTB.buddyName(member.clientId, member.name, roster).toLowerCase();
			let rank;
			if (!q || label.startsWith(q)) rank = 0;
			else if (label.includes(q)) rank = 1;
			else if (isSubsequence(q, label)) rank = 2;
			else return;
			scored.push({ member, rank, index });
		});
		scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
		return scored.map((s) => s.member);
	},

	/**
	 * Resolve a stored Mention target (a Client ID) to that member's CURRENT
	 * Display Name for inline "@Bob" rendering. A member who left the Room (or
	 * never set a name) falls back to the stable "<Adjective> Buddy" token —
	 * never a raw Client ID (ADR-0006).
	 * @param {Array<{clientId: string, name: string}>} roster
	 * @param {string} clientId
	 * @returns {string}
	 */
	mentionName(roster, clientId) {
		const member = (roster || []).find((m) => m.clientId === clientId);
		return YTB.buddyName(clientId, member && member.name, roster);
	},

	/**
	 * The current watch page's video title, read at write time by everything that
	 * freezes a title into a record: the Note Composer (a Note's `videoTitle`) and
	 * both Recommendation entry points (a Playlist Item's `title`). The `doc` is
	 * passed in rather than closed over so this file stays DOM-free — it also
	 * loads in the popup, which has no player — and so the selector fallback stays
	 * testable. Prefers the metadata heading; falls back to the tab title.
	 * @param {Document} doc
	 * @returns {string} '' when the page offers no title
	 */
	watchTitle(doc) {
		const heading = doc.querySelector('ytd-watch-metadata h1');
		const text = heading && heading.textContent ? heading.textContent.trim() : '';
		return text || doc.title.replace(/ - YouTube$/, '').trim();
	},

	/**
	 * The Room Feed's context fragment for the Note a reply/mention row points at:
	 * `on "Title"`, or '' when the Note carries no title (posted before Notes
	 * captured one, or from a page that offered none). Deliberately NO placeholder
	 * — a row that cannot name its video simply doesn't. Plain text: unlike a
	 * System Message's quoted title, this fragment is never a link.
	 * @param {?{videoTitle?: string}} note
	 * @returns {string}
	 */
	videoContext(note) {
		const title = note && typeof note.videoTitle === 'string' ? note.videoTitle.trim() : '';
		return title === '' ? '' : 'on "' + title + '"';
	},

	/**
	 * Tooltip for a Room Feed row's quoted-body link. The visible text is the
	 * Note's or Reply's body, so the link's destination — the Note's video, at the
	 * Note's moment — is nowhere on the row; the tooltip names both:
	 * `Open this note on "Title" at 6:52`. The `on "Title"` clause drops when the
	 * Note carries no title, the same no-placeholder rule as videoContext.
	 * @param {{videoTitle?: string, timestamp: number}} note
	 * @returns {string}
	 */
	noteLinkTooltip(note) {
		const context = YTB.videoContext(note);
		const at = YTB.formatTime(note && note.timestamp);
		return 'Open this note ' + (context === '' ? '' : context + ' ') + 'at ' + at;
	},

	/**
	 * Tooltip for a System Message / Watch Notice's title link, which opens the
	 * video's watch page: `Watch "Title"`. Falls back to `Watch this video` when
	 * the row has no title, mirroring the link's own "a video" label.
	 * @param {?string} title
	 * @returns {string}
	 */
	titleLinkTooltip(title) {
		const trimmed = typeof title === 'string' ? title.trim() : '';
		return trimmed === '' ? 'Watch this video' : 'Watch "' + trimmed + '"';
	},

	/**
	 * Render plan for one recommend System Message row — pure; home-section.js
	 * executes it (the deleteConfirmCopy/goHereTarget/dotActivation pattern).
	 * Live vs struck is a per-EVENT state carried on the buildFeed item as
	 * `removed`. A struck line renders NO anchor at all — the sole exception to
	 * the Room Feed's link rule: `linkVideoId` is null, so the title lands on
	 * the plain-text fallback in the line's own muted color, with no link
	 * tooltip. Because a line-through conveys nothing to a screen reader, a
	 * struck line instead carries a "No longer recommended" `rowTooltip` and a
	 * visually-hidden `srSuffix` inside the sentence.
	 * @param {{own?: boolean, removed?: boolean, event: {videoId?: string, title?: string, actorClientId?: string}}} item a buildFeed 'system' item
	 * @param {Array<{clientId: string, name?: string}>} roster the Room roster, for the recommender's Display Name
	 * @returns {{struck: boolean, prefix: string, label: string, suffix: string, linkVideoId: ?string, linkTooltip: ?string, rowTooltip: ?string, srSuffix: ?string}}
	 */
	systemLine(item, roster) {
		const event = (item && item.event) || {};
		const struck = Boolean(item && item.removed);
		const linked = !struck && Boolean(event.videoId);
		return {
			struck,
			prefix: item && item.own ? 'You recommended ' : YTB.mentionName(roster, event.actorClientId) + ' recommended ',
			label: event.title || 'a video',
			suffix: item && item.own ? ' to the Room' : '',
			linkVideoId: linked ? event.videoId : null,
			linkTooltip: linked ? YTB.titleLinkTooltip(event.title) : null,
			rowTooltip: struck ? 'No longer recommended' : null,
			srSuffix: struck ? ' (no longer recommended)' : null,
		};
	},

	/**
	 * "Watched by" attribution for one recommended video, derived live from
	 * the Room's Progress Records: "You" first (only when you have a record for
	 * the video), then up to two Buddy Display Names most-recent first (blank
	 * names via the buddyName fallback), then "and N other(s)". Returns '' when
	 * nobody in the Room has a Progress Record for the video.
	 * @param {Array<object>} progress Room read progress records (all members).
	 * @param {string} videoId
	 * @param {string} myClientId
	 * @param {Array<{clientId: string, name?: string}>} [roster] the Room roster; makes Buddy names Room-unique.
	 * @returns {string} e.g. "You, Bob, and 1 other"
	 */
	watchedByLabel(progress, videoId, myClientId, roster) {
		const latest = new Map(); // clientId -> latest record (for its name)
		for (const r of progress || []) {
			if (!r || !r.clientId || r.videoId !== videoId) continue;
			const prev = latest.get(r.clientId);
			if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.clientId, r);
		}
		const parts = [];
		if (latest.has(myClientId)) {
			parts.push('You');
			latest.delete(myClientId);
		}
		const buddies = [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		for (const record of buddies.slice(0, 2)) parts.push(YTB.buddyName(record.clientId, record.name, roster));
		const rest = buddies.length - Math.min(buddies.length, 2);
		if (rest > 0) parts.push(`and ${rest} other${rest === 1 ? '' : 's'}`);
		if (parts.length === 0) return '';
		if (parts.length === 1) return parts[0];
		if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
		// Three or more: Oxford-comma list; the collapsed tail already says "and".
		const last = parts[parts.length - 1];
		return parts.slice(0, -1).join(', ') + ', ' + (last.startsWith('and ') ? last : 'and ' + last);
	},

	/**
	 * Each viewer's "Recommended for you" grid, derived from the Room's
	 * Recommendations (ADR-0007): the items whose `addedBy` is NOT the viewer
	 * (you never recommend to yourself), minus the videoIds the viewer has
	 * Dismissed locally, newest recommendation first.
	 * @param {Array<{videoId: string, addedBy: string, addedAt: number}>} playlist Room read items.
	 * @param {string} myClientId
	 * @param {Iterable<string>} [dismissedVideoIds] this Room's local Dismissals.
	 * @returns {Array<object>}
	 */
	recommendedForYou(playlist, myClientId, dismissedVideoIds) {
		const dismissed = new Set(dismissedVideoIds || []);
		return (playlist || [])
			.filter((item) => item && item.videoId && item.addedBy !== myClientId && !dismissed.has(item.videoId))
			.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
	},

	// --- Dismissed Recommendations (ADR-0007) ---
	// A Dismiss hides one Recommendation from this viewer's Recommended-for-you
	// grid only. Stored per install in chrome.storage.local, Room-scoped and
	// keyed by videoId (mirroring Buddy Color storage); it never reaches the
	// backend, so the Room-level Recommendation stays intact for every other
	// member. There is deliberately no un-dismiss yet.

	/**
	 * The videoIds this viewer has Dismissed in one Room.
	 * @param {string} code Room Code (already normalized).
	 * @returns {Promise<Array<string>>}
	 */
	async dismissedVideoIds(code) {
		if (!code) return [];
		const stored = await YTB._storageGet('dismissedVideos');
		const all = (stored && stored.dismissedVideos) || {};
		return Array.isArray(all[code]) ? all[code] : [];
	},

	/**
	 * Dismiss one Recommendation locally: persist its videoId under the Room so
	 * it stays hidden across reloads. Idempotent, local-only (no backend write).
	 * @param {string} code Room Code (already normalized).
	 * @param {string} videoId
	 * @returns {Promise<Array<string>>} the Room's updated Dismissed list.
	 */
	async dismissVideo(code, videoId) {
		if (!code || !videoId) return YTB.dismissedVideoIds(code);
		const stored = await YTB._storageGet('dismissedVideos');
		if (!YTB.isContextActive()) return [];
		const all = (stored && stored.dismissedVideos) || {};
		const room = Array.isArray(all[code]) ? all[code] : [];
		if (room.includes(videoId)) return room;
		all[code] = [...room, videoId];
		await YTB._storageSet({ dismissedVideos: all });
		return all[code];
	},

	// --- Unseen Mentions & Replies (ADR-0010) ---
	// A Note or Reply addressed to the viewer is Unseen until Acknowledged; its
	// Note Dot pulses on the Video Timeline. The derivation is pure (these two
	// helpers); the seen set lives in chrome.storage.local below — private, per
	// install, Room-scoped, structurally identical to a Dismiss. It never
	// reaches the backend.

	/**
	 * The Note ids whose Video Timeline dots pulse: each anchors at least one
	 * Unseen item for the viewer — the Note itself as an Unseen Mention
	 * (noteAddressesMe), or an Unseen Reply beneath it (replyAddressesMe) —
	 * exactly the records the Room Feed surfaces, minus the seen set. A
	 * Reaction never pulses (no Mentions, no Replies — enforced here even
	 * against a malformed record); a locked Spoiler can. A Reply whose parent
	 * Note is absent from the read has no dot to anchor to and is ignored.
	 * @param {{notes?: Array, replies?: Array}} records a Room read
	 * @param {string} myClientId
	 * @param {Iterable<string>} [seenIds] the Room's Acknowledged ids
	 * @returns {Array<string>} Note ids to pulse
	 */
	unseenNoteIds(records, myClientId, seenIds) {
		const seen = new Set(seenIds || []);
		const notes = (records && records.notes) || [];
		const replies = (records && records.replies) || [];
		const noteById = new Map(notes.filter((note) => note && note.id).map((note) => [note.id, note]));
		const out = new Set();
		for (const note of notes) {
			if (!note || note.kind === 'emoji' || seen.has(note.id)) continue;
			if (YTB.noteAddressesMe(note, myClientId)) out.add(note.id);
		}
		for (const reply of replies) {
			if (!reply || seen.has(reply.id)) continue;
			const parent = noteById.get(reply.noteId);
			if (!parent || parent.kind === 'emoji') continue;
			if (YTB.replyAddressesMe(reply, parent, myClientId)) out.add(parent.id);
		}
		return [...out];
	},

	/**
	 * The exact ids Acknowledging one Note Dot clears: every item addressed to
	 * the viewer anchored to that dot — the Note itself when it Mentions them,
	 * plus every Reply beneath it addressed to them. Independent of the seen
	 * set (re-adding a seen id is a no-op), so Acknowledge stays idempotent.
	 * Empty for a Reaction, an unknown id, or a dot with nothing addressed to
	 * the viewer.
	 * @param {{notes?: Array, replies?: Array}} records a Room read
	 * @param {string} myClientId
	 * @param {string} noteId the Acknowledged dot's Note id
	 * @returns {Array<string>}
	 */
	acknowledgeTargets(records, myClientId, noteId) {
		const notes = (records && records.notes) || [];
		const note = notes.find((candidate) => candidate && candidate.id === noteId);
		if (!note || note.kind === 'emoji') return [];
		const ids = [];
		if (YTB.noteAddressesMe(note, myClientId)) ids.push(note.id);
		for (const reply of (records && records.replies) || []) {
			if (reply && reply.id && reply.noteId === noteId && YTB.replyAddressesMe(reply, note, myClientId)) ids.push(reply.id);
		}
		return ids;
	},

	/**
	 * The Note/Reply ids this viewer has Acknowledged in one Room.
	 * @param {string} code Room Code (already normalized).
	 * @returns {Promise<Array<string>>}
	 */
	async seenIds(code) {
		if (!code) return [];
		const stored = await YTB._storageGet('seenItems');
		const all = (stored && stored.seenItems) || {};
		return Array.isArray(all[code]) ? all[code] : [];
	},

	/**
	 * Acknowledge: persist ids into the Room's seen set so the dot never
	 * pulses again — across reloads, SPA navigations, and sessions. Idempotent,
	 * local-only (no backend write); a no-op write is skipped entirely.
	 * @param {string} code Room Code (already normalized).
	 * @param {Iterable<string>} ids Note/Reply ids (from acknowledgeTargets).
	 * @returns {Promise<Array<string>>} the Room's updated seen list.
	 */
	async markSeen(code, ids) {
		const additions = [...(ids || [])].filter((id) => typeof id === 'string' && id !== '');
		if (!code || additions.length === 0) return YTB.seenIds(code);
		const stored = await YTB._storageGet('seenItems');
		if (!YTB.isContextActive()) return [];
		const all = (stored && stored.seenItems) || {};
		const room = Array.isArray(all[code]) ? all[code] : [];
		const merged = new Set(room);
		for (const id of additions) merged.add(id);
		if (merged.size === room.length) return room;
		all[code] = [...merged];
		await YTB._storageSet({ seenItems: all });
		return all[code];
	},

	/**
	 * Prune the Room's seen set against a (successful) Room read: ids no longer
	 * live — aged out on the 14-day TTL, or deleted — are dropped so the set
	 * cannot grow without bound. Never prune against a FAILED read: its empty
	 * arrays would wipe the set and resurrect every Acknowledged pulse.
	 * @param {string} code Room Code (already normalized).
	 * @param {Iterable<string>} liveIds every Note + Reply id in the read.
	 * @returns {Promise<Array<string>>} the Room's surviving seen list.
	 */
	async pruneSeen(code, liveIds) {
		if (!code) return [];
		const stored = await YTB._storageGet('seenItems');
		if (!YTB.isContextActive()) return [];
		const all = (stored && stored.seenItems) || {};
		const room = Array.isArray(all[code]) ? all[code] : [];
		const live = new Set(liveIds || []);
		const kept = room.filter((id) => live.has(id));
		if (kept.length === room.length) return room;
		all[code] = kept;
		await YTB._storageSet({ seenItems: all });
		return kept;
	},

	/** Local calendar day of an epoch-ms instant, e.g. "2026-07-05". */
	_dayKey(ms) {
		const d = new Date(Number(ms) || 0);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	},

	/**
	 * Human label for a Feed day divider: "Today", "Yesterday", or a short
	 * date ("Jul 3").
	 * @param {string} dayKey as produced by _dayKey / buildFeed
	 * @param {number} [nowMs]
	 * @returns {string}
	 */
	dayLabel(dayKey, nowMs = Date.now()) {
		if (dayKey === YTB._dayKey(nowMs)) return 'Today';
		if (dayKey === YTB._dayKey(nowMs - 24 * 3600_000)) return 'Yesterday';
		const [y, m, d] = String(dayKey)
			.split('-')
			.map((part) => Number(part));
		return new Date(y, m - 1, d).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
		});
	},

	/**
	 * Whether a Note is addressed to the viewer: a FOREIGN Note whose `mentions`
	 * include their Client ID (ADR-0006). This is the one "addressed to me" rule
	 * for Notes — the Room Feed (buildFeed) and the Unseen derivation
	 * (unseenNoteIds, ADR-0010) both consume it, so the two can never drift.
	 * @param {?{clientId?: string, mentions?: Array<string>}} note
	 * @param {string} myClientId
	 * @returns {boolean}
	 */
	noteAddressesMe(note, myClientId) {
		if (!note || note.clientId === myClientId) return false;
		return Array.isArray(note.mentions) && note.mentions.includes(myClientId);
	},

	/**
	 * Whether a Reply is addressed to the viewer: a FOREIGN Reply that either
	 * sits under the viewer's own Note or Mentions them. The Room Feed and the
	 * Unseen derivation share this rule too (see noteAddressesMe).
	 * @param {?{clientId?: string, mentions?: Array<string>}} reply
	 * @param {?{clientId?: string}} parentNote the Reply's parent Note, or null
	 * @param {string} myClientId
	 * @returns {boolean}
	 */
	replyAddressesMe(reply, parentNote, myClientId) {
		if (!reply || reply.clientId === myClientId) return false;
		if (parentNote && parentNote.clientId === myClientId) return true;
		return Array.isArray(reply.mentions) && reply.mentions.includes(myClientId);
	},

	/**
	 * Derive the viewer's personalized Room Feed from one Room read (ADR-0007):
	 *   - Replies by Buddies to Notes the viewer authored;
	 *   - Notes/Replies whose `mentions` include the viewer (a Reply that is
	 *     both "to my Note" and "mentions me" appears exactly once);
	 *   - recommend System Messages from Playlist `added` Events, shown to EVERY
	 *     member (ADR-0007 amendment): recipients as "X recommended Title" and
	 *     the recommender as their own "You recommended Title to the Room" —
	 *     `own` marks which; non-`added` events are ignored so a stale
	 *     un-recommend never surfaces. Each carries `removed` — a per-EVENT
	 *     state (ADR-0007, 2026-07-09 amendment): true when a newer `added`
	 *     Event exists for the same videoId (superseded) OR when the videoId is
	 *     no longer in the Room's live Recommendation list (un-recommended) —
	 *     and the renderer strikes the line through (un-recommends emit no event);
	 *   - Watch Notices ("X started watching Title") shown ONLY to the recommender:
	 *     one per (Buddy, video) whenever a Buddy has a Progress Record for a
	 *     video the viewer recommended (`addedBy` == viewer), timestamped by that
	 *     record's `updatedAt`. Best-effort — cannot tell watched-before from
	 *     watched-after, and may reorder relative to the true watch instant.
	 * Items are sorted oldest -> newest (chat order) and grouped under day
	 * dividers. There is deliberately NO read/unread state — the Feed just
	 * shows recent activity (records age out server-side after 14 days).
	 * @param {{notes?: Array, replies?: Array, events?: Array, playlist?: Array, progress?: Array}} records
	 * @param {string} myClientId
	 * @returns {Array<{dayKey: string, items: Array<{type: 'reply'|'mention'|'system'|'watch', at: number, note?: object, reply?: object, event?: object, own?: boolean, removed?: boolean, videoId?: string, title?: string, clientId?: string, name?: string}>}>}
	 */
	buildFeed(records, myClientId) {
		const notes = (records && records.notes) || [];
		const replies = (records && records.replies) || [];
		const events = (records && records.events) || [];
		const playlist = (records && records.playlist) || [];
		const progress = (records && records.progress) || [];
		const noteById = new Map(notes.map((note) => [note.id, note]));

		const items = [];
		for (const reply of replies) {
			if (!reply) continue;
			const parent = noteById.get(reply.noteId) || null;
			// "Addressed to me" is the shared replyAddressesMe rule (own writes are
			// never news to me); the Unseen derivation consumes the same predicate.
			if (!YTB.replyAddressesMe(reply, parent, myClientId)) continue;
			const toMyNote = Boolean(parent) && parent.clientId === myClientId;
			items.push({
				type: toMyNote ? 'reply' : 'mention',
				at: Number(reply.createdAt) || 0,
				reply,
				note: parent,
			});
		}
		for (const note of notes) {
			if (!YTB.noteAddressesMe(note, myClientId)) continue;
			items.push({ type: 'mention', at: Number(note.createdAt) || 0, note });
		}
		// Recommend System Messages: every member gets one per `added` event —
		// the recommender their own (`own: true`, rendered "You recommended ...")
		// and everyone else the recipient line (ADR-0007 amendment). Only `added`
		// events count: un-recommends emit no event, so a non-`added` event is
		// stale and must never render as a recommendation. Instead, removal is
		// derived here, per EVENT (ADR-0007, 2026-07-09 amendment): an `added`
		// Event is `removed` when a NEWER `added` Event exists for the same
		// videoId (superseded — the backend re-add is a no-op for an already-live
		// videoId, so a second Event only exists after a delete, making every
		// older sibling necessarily dead), or when its videoId has dropped out of
		// the Room's live Recommendation list (currently un-recommended). So a
		// re-recommend revives only its own fresh line; the old, dead line stays
		// struck instead of silently reading as live again.
		const liveRecommendationIds = new Set();
		for (const item of playlist) {
			if (item && item.videoId) liveRecommendationIds.add(item.videoId);
		}
		const newestAddedAt = new Map(); // videoId -> max(at) among `added` Events
		for (const event of events) {
			if (!event || event.type !== 'added') continue;
			const at = Number(event.at) || 0;
			if (at > (newestAddedAt.get(event.videoId) ?? -Infinity)) newestAddedAt.set(event.videoId, at);
		}
		for (const event of events) {
			if (!event || event.type !== 'added') continue;
			const at = Number(event.at) || 0;
			items.push({
				type: 'system',
				at,
				event,
				own: event.actorClientId === myClientId,
				removed: at < newestAddedAt.get(event.videoId) || !liveRecommendationIds.has(event.videoId),
			});
		}
		// Watch Notices: for each video the viewer recommended, one notice per
		// Buddy who has a Progress Record for it. Titles come from the live
		// Recommendation (the Playlist Item), never the Progress Record.
		const myRecTitles = new Map();
		for (const item of playlist) {
			if (item && item.videoId && item.addedBy === myClientId) myRecTitles.set(item.videoId, item.title);
		}
		for (const record of progress) {
			if (!record || !record.clientId || record.clientId === myClientId) continue; // Buddies only
			if (!myRecTitles.has(record.videoId)) continue;
			items.push({
				type: 'watch',
				at: Number(record.updatedAt) || 0,
				videoId: record.videoId,
				title: myRecTitles.get(record.videoId),
				clientId: record.clientId,
				name: record.name,
			});
		}
		items.sort((a, b) => a.at - b.at);

		const groups = [];
		let current = null;
		for (const item of items) {
			const dayKey = YTB._dayKey(item.at);
			if (!current || current.dayKey !== dayKey) {
				current = { dayKey, items: [] };
				groups.push(current);
			}
			current.items.push(item);
		}
		return groups;
	},

	/**
	 * Trim a day-grouped Feed (the output of buildFeed) down to its newest
	 * `limit` items — the Room Feed's reveal window behind "Show more". The
	 * window is item-level, not day-level: a partly revealed day keeps its
	 * divider with only the newest tail of its items, and a day left with no
	 * revealed items is dropped entirely (no divider). Pure — the input groups
	 * and their item arrays are never mutated — so the window is independently
	 * unit-testable beside buildFeed, whose contract stays untouched.
	 * @param {Array<{dayKey: string, items: Array}>} groups day-grouped output of buildFeed
	 * @param {number} limit how many items to keep, counted from the newest
	 * @returns {{groups: Array<{dayKey: string, items: Array}>, hidden: number}}
	 *   the trimmed groups plus how many older items the window hid
	 */
	tailFeed(groups, limit) {
		const source = Array.isArray(groups) ? groups : [];
		const total = source.reduce((sum, group) => sum + (((group && group.items) || []).length || 0), 0);
		const keep = Math.max(0, Math.min(total, Math.floor(Number(limit) || 0)));
		const hidden = total - keep;
		const trimmed = [];
		let toSkip = hidden; // items are oldest -> newest, so hide from the front
		for (const group of source) {
			const items = (group && group.items) || [];
			if (toSkip >= items.length) {
				toSkip -= items.length; // whole day hidden — its divider renders nowhere
				continue;
			}
			trimmed.push({ dayKey: group.dayKey, items: items.slice(toSkip) });
			toSkip = 0;
		}
		return { groups: trimmed, hidden };
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

	// Playful adjectives for unnamed Buddies (see buddyName). Spreads unnamed
	// Buddies across the small set ever on screen; same-adjective collisions
	// within a Room are broken by disambiguateNames, so this need not be huge.
	ADJECTIVES: ['Silly', 'Sleepy', 'Sweaty', 'Big', 'Little', 'Buddy', 'Good-looking', 'Sloppy', 'Zesty', 'Stinky'],

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
	 * Base display label for a Buddy WITHOUT Room context: their trimmed Display
	 * Name when set, else a stable "<Adjective> Buddy" derived from their Client
	 * ID (same adjective on every surface and for every viewer). Two members can
	 * collide on the same base — a shared adjective, or the same typed name — so
	 * anything user-facing goes through buddyName with a roster to disambiguate.
	 * @param {string} clientId
	 * @param {string} [name]
	 * @returns {string}
	 */
	baseBuddyName(clientId, name) {
		const trimmed = String(name ?? '').trim();
		if (trimmed) return trimmed;
		const adjs = YTB.ADJECTIVES;
		const h = YTB.hashClientId(clientId);
		return `${adjs[((h % adjs.length) + adjs.length) % adjs.length]} Buddy`;
	},

	/**
	 * Map every Client ID in a Room roster to a label that is UNIQUE within the
	 * Room. Base labels come from baseBuddyName; when two or more members share
	 * one, they are ordered by Client ID (a viewer-independent total order) and
	 * each successive duplicate gains one more "Very " prefix — so a colliding
	 * pair reads "Silly Buddy" / "Very Silly Buddy", a triple adds "Very Very …".
	 * Deterministic: the same roster yields the same label for a given Client ID
	 * on every surface and for every viewer. Applies to real names too, so two
	 * "Alex"es become "Alex" / "Very Alex".
	 * @param {Array<{clientId: string, name?: string}>} roster
	 * @returns {Map<string, string>} clientId -> unique display label
	 */
	disambiguateNames(roster) {
		const groups = new Map(); // base label -> clientId[]
		for (const m of roster || []) {
			if (!m || !m.clientId) continue;
			const base = YTB.baseBuddyName(m.clientId, m.name);
			const ids = groups.get(base);
			if (ids) ids.push(m.clientId);
			else groups.set(base, [m.clientId]);
		}
		const labels = new Map();
		for (const [base, ids] of groups) {
			ids.sort();
			ids.forEach((id, i) => labels.set(id, 'Very '.repeat(i) + base));
		}
		return labels;
	},

	/**
	 * Display label for a Buddy. Without a roster, returns the base label (trimmed
	 * Display Name or the stable "<Adjective> Buddy" fallback). WITH the Room
	 * roster, returns the Room-unique label (see disambiguateNames) so no two
	 * members ever read the same on screen. Applies to FOREIGN records only; you
	 * never render yourself as a Buddy.
	 * @param {string} clientId
	 * @param {string} [name]
	 * @param {Array<{clientId: string, name?: string}>} [roster] the Room roster; enables disambiguation.
	 * @returns {string}
	 */
	buddyName(clientId, name, roster) {
		if (roster) return YTB.disambiguateNames(roster).get(clientId) || YTB.baseBuddyName(clientId, name);
		return YTB.baseBuddyName(clientId, name);
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
