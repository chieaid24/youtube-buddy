// extension/shared.js
// The window.YTB global: backend URL, config storage, API client, formatting utils.
// Loaded by both the popup and as the first content script; no ES modules (ADR-0001),
// communicates only via window.YTB.
// code ownership: getRecords(code) takes code as an arg; postProgress reads it from
// config (already-normalized, so the API client passes it through verbatim).

// Shared Room-scoped local-list persistence for Dismissals and seen ids:
// { [storageKey]: { [roomCode]: string[] } }. Public YTB functions own input filtering.
const roomScopedLocalLists = {
	async read(storageKey, code) {
		if (!code) return [];
		const stored = await YTB._storageGet(storageKey);
		if (!YTB.isContextActive()) return [];
		const value = stored && stored[storageKey];
		if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
		return Array.isArray(value[code]) ? value[code] : [];
	},

	async update(storageKey, code, transform) {
		if (!code) return [];
		const stored = await YTB._storageGet(storageKey);
		if (!YTB.isContextActive()) return [];
		const value = stored && stored[storageKey];
		const all = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		const current = Array.isArray(all[code]) ? all[code] : [];
		const next = transform(current);
		const unchanged = next.length === current.length && next.every((item, index) => item === current[index]);
		if (unchanged) return current;
		await YTB._storageSet({ [storageKey]: { ...all, [code]: next } });
		return next;
	},
};

const YTB = {
	// A Chrome extension reload/update revokes an already-injected content script's
	// API access; treat that one error as terminal for the stale script (harmless
	// in the popup, which Chrome just destroys).
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
	// Local dev backend; update alongside manifest.json host_permissions before deploying.
	BACKEND_URL: 'http://localhost:8787',

	// One Room of at most this many distinct Client IDs. Mirrors backend MAX_MEMBERS;
	// the server enforces it, the client uses it to detect a full Room (see roomView).
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

	// The Expanded Note omits "Go here" within this many seconds of the Note's moment
	// (nearNoteMoment); independent of the "natural crossing" delta in notes.js.
	GO_HERE_NEAR_SECONDS: 2,

	// --- storage (chrome.storage.local) ---
	// Stored keys: name, code, clientId, sharing, homeSectionHidden, the Settings
	// keys (theme, spoilerDefault, notificationPosition, notesHidden,
	// buddyProgressHidden), and the Room-scoped buddyColors + dismissedRecommendations +
	// seenItems maps.

	/**
	 * Read the full config, applying defaults for unset keys; clientId is "" until
	 * ensureClientId() mints one.
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
	 * Merge-write a subset of { name, code, sharing }; clientId is owned by
	 * ensureClientId, not writable here.
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
	 * Whether the Room Home Toggle turned the Room Home Section off. Per install
	 * (not Room-scoped); absent means visible.
	 * @returns {Promise<boolean>}
	 */
	async getHomeSectionHidden() {
		const { homeSectionHidden } = await YTB._storageGet('homeSectionHidden');
		return homeSectionHidden === true;
	},

	/**
	 * Persist the Room Home Toggle state, coerced to a strict boolean so it
	 * round-trips getHomeSectionHidden exactly.
	 * @param {boolean} hidden
	 * @returns {Promise<boolean>} false when the extension context is gone.
	 */
	async setHomeSectionHidden(hidden) {
		return await YTB._storageSet({ homeSectionHidden: hidden === true });
	},

	// Room Feed row click -> notes.js handoff (ADR-0010): the videoId is recorded here
	// (storage, not an in-memory event, so it survives SPA navigation and full reloads)
	// and consumed on arrival's first Room read to pause when an Unseen dot exists;
	// the TTL expires a stale click.
	PENDING_ARRIVAL_TTL_MS: 30_000,

	// Window after a Room Feed arrival during which a video `play` is treated as
	// autoplay churn (re-pause) rather than the viewer's resume; see YTB.playAction.
	PANEL_LOAD_GRACE_MS: 4_000,
	_arrivalGraceUntil: 0,

	/**
	 * Arm the ADR-0010 arrival grace; lives here so either overlay can cancel it
	 * on an explicit Picture Click.
	 * @param {number} now
	 * @returns {number} the grace deadline
	 */
	startArrivalGrace(now = Date.now()) {
		YTB._arrivalGraceUntil = Number(now) + YTB.PANEL_LOAD_GRACE_MS;
		return YTB._arrivalGraceUntil;
	},

	withinArrivalGrace(now = Date.now()) {
		return Number(now) < YTB._arrivalGraceUntil;
	},

	cancelArrivalGrace() {
		YTB._arrivalGraceUntil = 0;
	},

	/**
	 * Record the video a Room Feed row points at for notes.js to consult after
	 * navigating; a single slot, so a newer click replaces an unconsumed older one.
	 * @param {string} videoId
	 * @returns {Promise<boolean>} false when the videoId is missing or context is gone.
	 */
	async setPendingArrival(videoId) {
		const id = videoId ? String(videoId) : '';
		if (!id) return false;
		return await YTB._storageSet({
			pendingArrival: { videoId: id, at: Date.now() },
		});
	},

	/**
	 * Read the pending arrival, or null when absent, malformed, or past its TTL.
	 * @returns {Promise<{videoId: string, at: number}|null>}
	 */
	async getPendingArrival() {
		const { pendingArrival } = await YTB._storageGet('pendingArrival');
		if (!pendingArrival || !pendingArrival.videoId) return null;
		if (Date.now() - (Number(pendingArrival.at) || 0) > YTB.PENDING_ARRIVAL_TTL_MS) return null;
		return pendingArrival;
	},

	/**
	 * Clear the pending arrival once notes.js has consumed it on the target video
	 * (or on expiry). Idempotent.
	 * @returns {Promise<boolean>}
	 */
	async clearPendingArrival() {
		return await YTB._storageSet({ pendingArrival: null });
	},

	// --- Settings (per install, chrome.storage.local — mirrors homeSectionHidden) ---

	// Theme Preference legal values (ADR-0008/0009): light/dark stamp data-theme
	// everywhere; system follows the OS in the popup, YouTube's own theme on-page
	// (see themeMarker, theme.js).
	THEMES: ['light', 'dark', 'system'],

	// Notification Position's four edges; Playback Notifications center along the
	// chosen player edge (notes.js).
	NOTIFICATION_EDGES: ['top', 'bottom', 'left', 'right'],

	/**
	 * Read every Settings key, coercing unset/junk values to defaults (theme
	 * 'system', Spoiler Default on, Notification Position bottom, Notes/Buddy
	 * Progress shown); Room Home Section has its own getHomeSectionHidden seam.
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
	 * Merge-write a subset of Settings keys, validating each so stored state
	 * round-trips getSettings exactly (illegal theme/edge dropped, flags coerced
	 * to booleans).
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
	 * Theme Preference -> data-theme decision (ADR-0008/0009): forced light/dark
	 * always wins; under Auto it mirrors the YouTube page's own darkness, or is
	 * left unset off-page (popup) to fall back to the OS media query.
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
	 * Show one shared, auto-dismissing page toast; theme.js owns the matching styles.
	 * @param {string} text
	 */
	toast(text) {
		let wrap = document.querySelector('.ytb-toast-wrap');
		if (!wrap) {
			wrap = document.createElement('div');
			wrap.className = 'ytb-toast-wrap';
			(document.body || document.documentElement).appendChild(wrap);
		}
		const toast = document.createElement('div');
		toast.className = 'ytb-toast';
		toast.textContent = String(text);
		wrap.appendChild(toast);
		requestAnimationFrame(() => toast.classList.add('show'));
		setTimeout(() => {
			toast.classList.remove('show');
			setTimeout(() => toast.remove(), 250);
		}, 4000);
	},

	/**
	 * Return the existing Client ID, or mint one ONCE (8 hex chars) and persist it;
	 * stable for the life of the install.
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

	// --- API client (talks to BACKEND_URL) ---

	/**
	 * POST this user's current Progress Record (Room Code read from config, no
	 * updatedAt - server sets it); tolerates failure silently per the PRD, resolving
	 * false on missing code / network / non-2xx.
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
	 * GET everything live under `code` (server does no filtering; consumers split
	 * mine vs Buddies' by clientId); resolves to empty arrays on any failure so
	 * callers never null-check.
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
				// Minimal error handling by design (PRD), but a silent non-2xx would be an
				// untraceable total Buddy blackout - so warn.
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
	 * POST a JSON payload and normalize the outcome to { ok: true, ...body } or
	 * { ok: false, category } (network/unexpected on failure); callers branch on
	 * category, never prose.
	 */
	async _postJson(pathAndQuery, payload) {
		try {
			const res = await fetch(YTB.BACKEND_URL + pathAndQuery, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const data = await res.json().catch(() => null);
			if (!data || typeof data !== 'object') return { ok: false, category: 'unexpected' };
			if (res.ok) return { ok: true, ...(data || {}) };
			return { ok: false, category: (data && data.category) || 'unexpected' };
		} catch {
			return { ok: false, category: 'network' };
		}
	},

	/**
	 * Post a text Note or curated-emoji Reaction; resolves { ok: true, note } with
	 * the complete server record, or { ok: false, category }. Requires a Room
	 * Code; Sharing does NOT gate Note writes (CONTEXT.md). videoTitle is captured
	 * at post time (watchTitle) and never required.
	 * @returns {Promise<{ok: true, note: object}|{ok: false, category: string}>}
	 */
	async postNote({ clientId, name, videoId, videoTitle, timestamp, kind, body, spoiler, mentions }) {
		const { code } = await YTB.getConfig();
		if (!code) return { ok: false, category: 'unpaired' };
		return YTB._postJson('/notes?code=' + encodeURIComponent(code), {
			clientId,
			name,
			videoId,
			timestamp,
			kind,
			body,
			spoiler,
			...(typeof videoTitle === 'string' && videoTitle !== '' ? { videoTitle } : {}),
			// Mentions are roster Client IDs (ADR-0006); omitted entirely when empty.
			...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
		});
	},

	/**
	 * Post a Reply to an existing text Note; resolves { ok: true, reply } with the
	 * complete server record, or { ok: false, category } (reply_cap, missing_parent,
	 * room_full). Requires a Room Code; Sharing does NOT gate Reply writes.
	 * @returns {Promise<{ok: true, reply: object}|{ok: false, category: string}>}
	 */
	async postReply({ clientId, name, noteId, body, mentions }) {
		const { code } = await YTB.getConfig();
		if (!code) return { ok: false, category: 'unpaired' };
		return YTB._postJson('/replies?code=' + encodeURIComponent(code), {
			clientId,
			name,
			noteId,
			body,
			...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
		});
	},

	/**
	 * Recommend a video to the Room (ADR-0007; API keeps the playlist name),
	 * reading Room Code from config; NOT gated by Sharing. Re-adding is a server
	 * no-op returning the existing item. Resolves { ok: true, item } or
	 * { ok: false, category } (playlist_full, room_full).
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
	 * Remove one Recommendation for everyone (the un-recommend point delete,
	 * ADR-0007); idempotent, server-permissive to any member though the UI only
	 * offers it to the recommender. Emits no Playlist Event.
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
			return { ok: false, category: 'network' };
		}
	},

	/**
	 * Focused conversation read for an open Expanded Note (parent + Replies
	 * oldest-first), cheap enough to poll every 5s without a full Room read;
	 * missing_parent means the Note was deleted while open.
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
	 * Announce "I'm here" under `code`, independent of watching/Sharing; idempotent
	 * upsert doubling as a keep-alive and pre-presence backfill.
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
	 * Remove my membership from `code` (presence + every Progress Record),
	 * idempotent on the server; best-effort, records TTL out on failure.
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
	 * Fold one Room-read outcome into a poller's consecutive-failure state;
	 * pollers own the counter, this only defines the shared threshold.
	 * @param {number} prevFailures
	 * @param {boolean} ok
	 * @returns {{failures: number, lost: boolean}}
	 */
	connectionState(prevFailures, ok) {
		const failures = ok ? 0 : Math.max(0, Math.floor(Number(prevFailures) || 0)) + 1;
		return { failures, lost: failures >= 2 };
	},

	/**
	 * Format seconds as "M:SS" (or "H:MM:SS" past an hour) for tooltips, e.g. 412 -> "6:52".
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
	 * Relative age label ("just now", "8 min ago", ... "1 year ago"), rounded down
	 * to the largest useful unit; UI copy prefixes "Posted ".
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
	 * User-facing copy for a failed write, keyed by the server's machine-readable
	 * category; unknown categories fall back to a generic retry message. Never
	 * surfaces backend prose.
	 * @param {string} category
	 * @param {'note'|'reply'|'reaction'|'recommendation'} action
	 * @returns {string}
	 */
	errorCopy(category, action) {
		if (category === 'network') return "Can't reach the backend. Check your connection and try again.";
		if (category === 'reply_cap') return 'This note already has 10 replies.';
		if (category === 'room_full') return "This Room is full, so you can't post here.";
		if (category === 'missing_parent') return 'This note is no longer available.';
		return `We couldn't post your ${action}. Try again.`;
	},

	/**
	 * Copy for the author-only delete confirmation; a Note's delete cascades to
	 * its conversation, so this says exactly how many Replies go with it.
	 * @param {number} replyCount
	 * @returns {string}
	 */
	deleteConfirmCopy(replyCount) {
		const count = Math.max(0, Math.floor(Number(replyCount) || 0));
		if (count === 0) return 'Really delete it?';
		return `Really delete it? This will also delete ${count === 1 ? '1 reply' : `${count} replies`}.`;
	},

	/**
	 * Where "Go here" seeks to: about one second before the Note's timestamp
	 * (clamped at 0), so resuming crosses it naturally and fires its own notification.
	 * @param {number} timestamp the Note's video timestamp in seconds
	 * @returns {number}
	 */
	goHereTarget(timestamp) {
		return Math.max(0, (Number(timestamp) || 0) - 1);
	},

	/**
	 * What activating a Note Dot/Preview does: always OPEN its Expanded Note
	 * (Timeline activation never seeks; Go here inside the panel is the only
	 * seek). Panel shape comes from notePanelVariant.
	 * @param {{kind?: string, spoiler?: boolean, timestamp?: number}} _note
	 * @returns {{action: 'open'}}
	 */
	dotActivation(_note) {
		return { action: 'open' };
	},

	// A Playback Notification's full lifetime on a natural crossing; a Post Echo
	// lives half (see notificationLifetime).
	NOTE_CARD_MS: 4000, // text-note card lifetime
	REACTION_BURST_MS: 2000, // Reaction float-and-fade lifetime

	/**
	 * A Playback Notification's lifetime in ms, keyed on kind and trigger: a
	 * crossing gets the full lifetime, a Post Echo half (the author already knows
	 * what they wrote); keyed on trigger not authorship, so a rewind-replay across
	 * your own Note behaves like a Buddy's.
	 * @param {string} kind the record kind ('emoji' for a Reaction, else a text card)
	 * @param {'crossing'|'echo'} trigger what fired the notification
	 * @returns {number} lifetime in ms
	 */
	notificationLifetime(kind, trigger) {
		const full = kind === 'emoji' ? YTB.REACTION_BURST_MS : YTB.NOTE_CARD_MS;
		return trigger === 'echo' ? full / 2 : full;
	},

	/**
	 * Classify a click relative to YouTube's player: known controls are chrome,
	 * the remaining player surface is the Video Picture. Callers exclude their
	 * own overlay controls first.
	 * @param {{closest?: (selector: string) => unknown}|null} target
	 * @returns {'picture'|'chrome'|'outside'}
	 */
	pictureClickRegion(target) {
		if (!target || typeof target.closest !== 'function') return 'outside';
		if (!target.closest('#movie_player, .html5-video-player')) return 'outside';
		if (
			target.closest(
				'.ytp-chrome-bottom, .ytp-chrome-top, .ytp-popup, .ytp-settings-menu, .ytp-panel-menu, button, a, input, select, textarea, [role="button"], [role="menu"], [role="menuitem"], [role="slider"]',
			)
		)
			return 'chrome';
		return 'picture';
	},

	/**
	 * Route an overlay-open click without touching DOM/playback: a Press Origin
	 * of 'overlay' only consumes the tail click; otherwise a Picture Click plays
	 * and closes, player chrome closes without playing, and off-player keeps
	 * Pause Hold semantics.
	 * @param {{overlayOpen: boolean, region: 'picture'|'chrome'|'outside', pressOrigin: 'overlay'|'elsewhere', pauseHold: boolean, withinGrace: boolean}} state
	 * @returns {{close: boolean, consume: boolean, play: boolean, cancelArrivalGrace: boolean}}
	 */
	pictureClickAction({ overlayOpen, region, pressOrigin, pauseHold, withinGrace }) {
		if (!overlayOpen)
			return {
				close: false,
				consume: false,
				play: false,
				cancelArrivalGrace: false,
			};
		if (pressOrigin === 'overlay') {
			return {
				close: false,
				consume: true,
				play: false,
				cancelArrivalGrace: false,
			};
		}
		if (region === 'picture') {
			return {
				close: true,
				consume: true,
				play: true,
				cancelArrivalGrace: Boolean(withinGrace),
			};
		}
		if (region === 'chrome') {
			return {
				close: true,
				consume: false,
				play: false,
				cancelArrivalGrace: false,
			};
		}
		return {
			close: true,
			consume: false,
			play: Boolean(pauseHold),
			cancelArrivalGrace: false,
		};
	},

	/**
	 * What a video `play` event does: inside the arrival grace (ADR-0010, autoplay
	 * settling after a Room Feed pause) it's 'hold' (re-pause); otherwise it
	 * dismisses an open Expanded Note, or is ignored.
	 * @param {{withinGrace: boolean, panelOpen: boolean}} state
	 * @returns {'hold'|'dismiss'|'ignore'}
	 */
	playAction({ withinGrace, panelOpen }) {
		if (withinGrace) return 'hold';
		return panelOpen ? 'dismiss' : 'ignore';
	},

	// --- Controls Hold (CONTEXT.md): keep YouTube's chrome awake while a Note is engaged ---

	// Ticker period for re-feeding YouTube's autohide timer, comfortably inside its
	// ~3s inactivity window.
	CONTROLS_HOLD_TICK_MS: 1500,

	/**
	 * The Controls Hold core: a REFCOUNTED hold on YouTube's control-bar autohide.
	 * Note Dots swallow pointer events so hovering never pops YouTube's storyboard/time
	 * pill, which starves its inactivity timer under a hovering hand; while any hold is
	 * live this feeds that timer instead (immediate on first acquire, then ticked), and
	 * the last release hands it straight back so the chrome fades on YouTube's own schedule.
	 * `acquire()` returns a ONE-SHOT release (repeated calls decrement once, never
	 * underflowing); dispatch/timers are injected seams so this is testable in workerd.
	 * @param {{dispatch: (tick: number) => void, tickMs?: number,
	 *   setTimer?: (fn: () => void, ms: number) => unknown,
	 *   clearTimer?: (id: unknown) => void}} deps
	 * @returns {{acquire: () => () => void, holders: () => number}}
	 */
	createControlsHold({
		dispatch,
		tickMs = YTB.CONTROLS_HOLD_TICK_MS,
		setTimer = (fn, ms) => setInterval(fn, ms),
		clearTimer = (id) => clearInterval(id),
	}) {
		let holders = 0;
		let timer = null;
		let tick = 0;
		// Guarded so a queued tick or stray leftover timer can never feed after release.
		const feed = () => {
			if (holders === 0) return;
			dispatch(tick++);
		};
		return {
			acquire() {
				holders += 1;
				if (holders === 1) {
					feed(); // wake NOW — the parked pointer is invisible to YouTube
					timer = setTimer(feed, tickMs);
				}
				let released = false;
				return () => {
					if (released) return;
					released = true;
					holders -= 1;
					if (holders === 0 && timer !== null) {
						clearTimer(timer);
						timer = null;
					}
				};
			},
			holders: () => holders,
		};
	},

	/**
	 * The real Controls Hold dispatch: a synthetic `mousemove` on the player root
	 * (not the progress bar, so no scrub preview/time pill), jittered by a pixel
	 * per tick to read as genuine movement; no-op without a player.
	 * @param {number} tick the hold's feed counter (drives the jitter)
	 */
	nudgePlayerControls(tick) {
		if (typeof document === 'undefined') return;
		const player = document.querySelector('#movie_player, .html5-video-player');
		if (!player) return;
		const rect = player.getBoundingClientRect();
		if (!(rect.width > 0) || !(rect.height > 0)) return;
		player.dispatchEvent(
			new MouseEvent('mousemove', {
				bubbles: true,
				cancelable: true,
				view: window,
				clientX: rect.left + rect.width / 2 + (tick % 2),
				clientY: rect.top + rect.height / 2 + (Math.floor(tick / 2) % 2),
			}),
		);
	},

	/**
	 * Hover-scope a Controls Hold onto one overlay element: holds only while a
	 * real pointer hover sits on it, releasing on mouseleave. HOVER ONLY, never
	 * keyboard focus - the Composer and Expanded Note auto-focus on open, so a
	 * focus-scoped hold would pin the chrome for their whole lifetime and recreate
	 * the autohide flicker this exists to kill.
	 * Returns a one-shot teardown the caller's close path must call, since the
	 * element usually leaves the DOM without a final mouseleave.
	 * @param {Element} element the overlay whose hover scopes the hold
	 * @returns {() => void}
	 */
	bindHoverHold(element) {
		let release = null;
		element.addEventListener('mouseenter', () => {
			release ||= YTB.controlsHold.acquire();
		});
		element.addEventListener('mouseleave', () => {
			release?.();
			release = null;
		});
		return () => {
			release?.();
			release = null;
		};
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
	 * Whether the paused playhead already sits within GO_HERE_NEAR_SECONDS of a
	 * Note's moment; when true, Go here is omitted entirely (nowhere to go). A
	 * missing/non-finite playhead is never near, so Go here shows.
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
	 * The Notes whose timestamps ordinary forward playback just crossed
	 * (previousTime < timestamp <= currentTime); the caller decides whether the
	 * step was natural, so a replay after rewinding triggers again.
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

	// --- Progress-bar geometry: the one time-to-x mapping both on-bar surfaces use ---

	/**
	 * The progress bar's chapter segments, in bar-local px, measured fresh each call.
	 * A chaptered bar is one `.ytp-chapter-hover-container` per chapter (width
	 * proportional to duration, 4px gaps), so a timestamp's x is NOT
	 * `fraction * barWidth` (#159); an unchaptered bar is a single full-width
	 * segment, which reduces to exactly that.
	 * The ONE place that reads YouTube's chapter DOM; the pure mapping is timeToX.
	 * @param {Element|null} bar the `.ytp-progress-bar` element
	 * @returns {Array<{left: number, width: number}>} segments, left to right
	 */
	barSegments(bar) {
		if (!bar) return [];
		const barRect = bar.getBoundingClientRect();
		const segments = [];
		for (const el of bar.querySelectorAll('.ytp-chapter-hover-container')) {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0) segments.push({ left: rect.left - barRect.left, width: rect.width });
		}
		segments.sort((a, b) => a.left - b.left);
		// Chapter DOM not built yet (async player init, late ytb:mutation re-render):
		// treat as one unchaptered segment.
		if (segments.length === 0 && barRect.width > 0) segments.push({ left: 0, width: barRect.width });
		return segments;
	},

	/**
	 * Map a timestamp to its x offset from the bar's left edge through the measured
	 * chapter geometry (#159): a timestamp's share of the total segment width (gaps
	 * excluded) places it at the same offset YouTube draws its own playhead at, so it
	 * never lands in an inter-segment gap (a boundary resolves to the end of the
	 * earlier chapter); an unchaptered bar reduces to `fraction * barWidth` exactly.
	 * @param {Array<{left: number, width: number}>} segments bar-local px, left to right
	 * @param {number} timestamp seconds into the video
	 * @param {number} duration the video's duration in seconds
	 * @returns {number} px offset from the bar's left edge
	 */
	timeToX(segments, timestamp, duration) {
		const segs = (segments || []).filter((s) => s && Number.isFinite(Number(s.left)) && Number(s.width) > 0);
		if (segs.length === 0) return 0;
		const t = Number(timestamp);
		const d = Number(duration);
		const fraction = Number.isFinite(t) && Number.isFinite(d) && d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
		const total = segs.reduce((sum, s) => sum + Number(s.width), 0);
		const contentPx = fraction * total;
		let consumed = 0;
		for (const s of segs) {
			const width = Number(s.width);
			if (contentPx <= consumed + width) return Number(s.left) + (contentPx - consumed);
			consumed += width;
		}
		const last = segs[segs.length - 1];
		return Number(last.left) + Number(last.width);
	},

	// --- Dot Cluster helpers (pure — the fan math, tested at the shared.js seam) ---

	/**
	 * The Dot Cluster fan (#162): a MINIMUM DISPLACEMENT solve over every Note Dot's
	 * at-rest x (from `timeToX`), constrained only to keep no two dot centers closer
	 * than the Fan Gap. A dot with slack never moves, and the constraint is GLOBAL
	 * (not per group), so a Dot Cluster is exactly the set of dots the constraint
	 * chains together into one rigid block. The Fan Gap opens to `idealGap` where the
	 * bar has room and shrinks toward one dot diameter (touch, never cover) where it
	 * doesn't; only when even that floor can't fit does the chain center on the bar,
	 * overhanging both ends, rather than cover its own dots.
	 *
	 * Solved as an L2 isotonic regression (PAVA): substituting z_i = x_i - i*gap turns
	 * "centers >= gap apart, in x order" into "z nondecreasing", whose minimum-displacement
	 * fit is the pooled block means; the bar's edges are a box constraint (a clamp) on
	 * that fit.
	 *
	 * Pure display math (no DOM) - the caller measures the bar and applies the returned
	 * offsets as a transform, so it is unit-tested at the shared.js seam.
	 * @param {number[]} xs each dot's px offset from the bar's left edge, at rest
	 * @param {{idealGap: number, barWidth: number, dotDiameter: number}} options
	 *   `idealGap` px between fanned dot centers where there is room; `barWidth` the
	 *   rendered progress-bar width; `dotDiameter` the dot's px diameter (and, by
	 *   definition, the Fan Gap's floor — touching, never covering).
	 * @returns {{clusters: number[][], offsets: number[], gap: number}} `clusters` of
	 *   ORIGINAL indices (into `xs`), each ordered left to right and the clusters
	 *   themselves left to right; `offsets` the per-dot fan displacement in px, in
	 *   INPUT order; `gap` the Fan Gap the fan actually resolved to.
	 */
	solveDotFan(xs, options) {
		const input = xs || [];
		const opts = options || {};
		const diameter = Math.max(0, Number(opts.dotDiameter) || 0);
		const width = Math.max(0, Number(opts.barWidth) || 0);
		// The floor is the dot diameter itself: fanned dots may touch, never cover.
		const ideal = Math.max(diameter, Number(opts.idealGap) || 0);
		const offsets = new Array(input.length).fill(0);
		const dots = input.map((x, index) => ({ index, x: Number(x) || 0 })).sort((a, b) => a.x - b.x || a.index - b.index);
		const n = dots.length;
		if (n === 0) return { clusters: [], offsets, gap: ideal };

		// Fan Gap: the n-1 gaps must fit within (width - diameter); an unmeasured bar
		// imposes no bound and keeps the ideal.
		const bounded = width > diameter;
		const room = bounded ? width - diameter : Infinity;
		const gap = n > 1 ? Math.min(ideal, Math.max(diameter, room / (n - 1))) : ideal;

		// PAVA fit of z_i = x_i - i*gap: pool adjacent blocks while the left's mean
		// exceeds the right's (i.e. would land closer than the Fan Gap); each
		// surviving block is a Cluster's rigid core.
		const blocks = []; // { sum, count, start } over the x-sorted dots
		for (let i = 0; i < n; i++) {
			let block = { sum: dots[i].x - i * gap, count: 1, start: i };
			while (blocks.length > 0) {
				const prev = blocks[blocks.length - 1];
				if (prev.sum / prev.count <= block.sum / block.count) break;
				blocks.pop();
				block = {
					sum: prev.sum + block.sum,
					count: prev.count + block.count,
					start: prev.start,
				};
			}
			blocks.push(block);
		}

		// Bar edges as a box constraint: each solved center in [radius, width-radius]
		// is a clamp into [lo, hi]; lo > hi means even the floor can't fit, so hold
		// the gap and center the chain.
		const radius = diameter / 2;
		let lo = -Infinity;
		let hi = Infinity;
		if (bounded) {
			lo = radius;
			hi = width - radius - (n - 1) * gap;
			if (lo > hi) {
				const mid = (lo + hi) / 2;
				lo = mid;
				hi = mid;
			}
		}

		const solved = new Array(n);
		for (const block of blocks) {
			const value = Math.min(Math.max(block.sum / block.count, lo), hi);
			for (let k = 0; k < block.count; k++) {
				const i = block.start + k;
				solved[i] = value + i * gap;
			}
		}

		// A Cluster is what the constraint chains together: dots left exactly the
		// Fan Gap apart once the solve settles.
		const EPS = 1e-6;
		const clusters = [];
		let current = null;
		for (let i = 0; i < n; i++) {
			if (current !== null && solved[i] - solved[i - 1] <= gap + EPS) current.push(i);
			else {
				current = [i];
				clusters.push(current);
			}
		}

		for (const cluster of clusters) {
			// A lone dot has no one to separate from and never moves (would be a
			// meaningless hover-time jitter).
			if (cluster.length === 1) continue;
			for (const i of cluster) offsets[dots[i].index] = solved[i] - dots[i].x;
		}
		// Report clusters in the caller's own index space, still left to right.
		return {
			clusters: clusters.map((cluster) => cluster.map((i) => dots[i].index)),
			offsets,
			gap,
		};
	},

	// --- Note Band geometry (pure — tested at the shared.js seam) ---

	/**
	 * The Note Band's numbers (#173; CONTEXT.md), the ONE place they live -
	 * notes.js builds its CSS from these, and the helpers below derive from them,
	 * so a change here carries every dependent surface together.
	 */
	NOTE_BAND: {
		dotLift: 10, // px from the bar's top edge up to a dot's bottom edge (#162)
		dotDiameter: 6, // the painted glyph
		hitMaxSideReach: 3, // max invisible reach beyond either side of the glyph
		hitHeight: 14, // its height — bottom-anchored at the dot's bottom edge, growing upward only (#158)
		panelGap: 8, // breathing room between the dot glyphs' tops and the Expanded Note's bottom edge
	},

	/**
	 * Per-side Note Dot hit reach (#202): each side stops at the nearer of its
	 * configured cap or the midpoint to that side's nearest neighbour.
	 * @param {number[]} xs each dot's px offset from the bar's left edge, at rest
	 * @param {number} dotDiameter the painted glyph's diameter in px
	 * @param {number} maxSideReach the cap beyond either side of the glyph
	 * @returns {{left: number, right: number}[]} per dot, in input order
	 */
	dotHitReaches(xs, dotDiameter, maxSideReach) {
		const px = (xs || []).map((x) => Number(x) || 0);
		const radius = Math.max(0, Number(dotDiameter) || 0) / 2;
		const cap = Math.max(0, Number(maxSideReach) || 0);
		const reach = (gap) => Math.min(cap, Math.max(0, gap / 2 - radius));
		return px.map((x, i) => {
			let leftGap = Infinity;
			let rightGap = Infinity;
			for (let j = 0; j < px.length; j++) {
				if (j === i) continue;
				const gap = px[j] - x;
				if (gap < 0) leftGap = Math.min(leftGap, -gap);
				else if (gap > 0) rightGap = Math.min(rightGap, gap);
				else leftGap = rightGap = 0;
			}
			return { left: reach(leftGap), right: reach(rightGap) };
		});
	},

	/**
	 * How far above the bar's top edge the Expanded Note rests: derived from the
	 * dot geometry (lift + glyph + breathing room) rather than hardcoded, so a
	 * lift change carries the panel with it (#173).
	 * @param {{dotLift?: number, dotDiameter?: number, panelGap?: number}} band
	 * @returns {number} px above the bar's top edge
	 */
	panelBarClearance(band) {
		const geometry = band || {};
		return (Number(geometry.dotLift) || 0) + (Number(geometry.dotDiameter) || 0) + (Number(geometry.panelGap) || 0);
	},

	// --- Own-churn + Watched-By ownership (pure — tested at the shared.js seam) ---

	/**
	 * Whether a MutationObserver batch is ENTIRELY the extension's own DOM churn
	 * (#174): a record is ours iff its target sits inside a YTB-owned
	 * (`ytb-`-prefixed) element, or every added/removed node is. content.js drops
	 * these instead of emitting `ytb:mutation`, so a render pass can never
	 * re-trigger itself (the loop that made YouTube's hover-autoplay preview
	 * flicker). Anything ambiguous counts as NOT ours - a redundant render pass
	 * is safe, a missed one is not.
	 * @param {Iterable<{target: object, addedNodes: Iterable, removedNodes: Iterable}>} records
	 * @returns {boolean} true iff there is at least one record and all are YTB-owned
	 */
	ytbOwnedChurn(records) {
		const isYtbElement = (node) => {
			if (!node || node.nodeType !== 1) return false;
			if (typeof node.id === 'string' && node.id.startsWith('ytb-')) return true;
			for (const cls of node.classList || []) {
				if (typeof cls === 'string' && cls.startsWith('ytb-')) return true;
			}
			return false;
		};
		// Owned if it or any attached ancestor is a YTB element; a removed node has
		// no parent, so ownership rests on the removed root itself.
		const isOwned = (node) => {
			for (let n = node; n; n = n.parentNode) {
				if (isYtbElement(n)) return true;
			}
			return false;
		};
		let any = false;
		for (const record of records || []) {
			any = true;
			if (isOwned(record.target)) continue;
			const churn = [...(record.addedNodes || []), ...(record.removedNodes || [])];
			if (churn.length === 0 || !churn.every(isOwned)) return false;
		}
		return any;
	},

	/**
	 * Whether YouTube's hover-autoplay preview host covers a tile's thumbnail box
	 * (#174, geometric half of preview-to-tile pairing; caller already matched
	 * videoIds). The host overflows its tile on every side, so requiring the
	 * intersection to cover at least half the tile's area keeps a duplicate
	 * elsewhere in the feed owning its own dots.
	 * @param {{left: number, top: number, right: number, bottom: number}} previewRect
	 * @param {{left: number, top: number, right: number, bottom: number}} tileRect
	 * @returns {boolean}
	 */
	previewOwnsTile(previewRect, tileRect) {
		if (!previewRect || !tileRect) return false;
		const width = Math.min(previewRect.right, tileRect.right) - Math.max(previewRect.left, tileRect.left);
		const height = Math.min(previewRect.bottom, tileRect.bottom) - Math.max(previewRect.top, tileRect.top);
		if (width <= 0 || height <= 0) return false;
		const tileArea = (tileRect.right - tileRect.left) * (tileRect.bottom - tileRect.top);
		return tileArea > 0 && width * height >= tileArea / 2;
	},

	// --- Room Home Section helpers (pure — tested at the shared.js seam) ---

	/**
	 * The Room's current roster: one entry per distinct Client ID across every
	 * record kind, carrying their latest nonblank Display Name, sorted newest
	 * activity first.
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
			// Only a record that carries a name can update it; Events are nameless
			// and must never blank out a known Display Name.
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
	 * Fuzzy-search the roster for @-mention autocomplete: prefix matches rank
	 * first, then substring, then in-order subsequence ("sly" finds "Silly
	 * Buddy"); ties keep roster order, empty query returns everything.
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
	 * Resolve a stored Mention Client ID to that member's current Display Name
	 * for inline "@Bob" rendering; falls back to the stable Adjective-Buddy
	 * token, never a raw Client ID (ADR-0006).
	 * @param {Array<{clientId: string, name: string}>} roster
	 * @param {string} clientId
	 * @returns {string}
	 */
	mentionName(roster, clientId) {
		const member = (roster || []).find((m) => m.clientId === clientId);
		return YTB.buddyName(clientId, member && member.name, roster);
	},

	/**
	 * The current watch page's video title, read at write time wherever a record
	 * freezes one in (Note videoTitle, Playlist Item title). `doc` is passed in
	 * (not closed over) since this file also loads in the popup, which has no
	 * player. Prefers the metadata heading, falls back to the tab title.
	 * @param {Document} doc
	 * @returns {string} '' when the page offers no title
	 */
	watchTitle(doc) {
		const heading = doc.querySelector('ytd-watch-metadata h1');
		const text = heading && heading.textContent ? heading.textContent.trim() : '';
		return text || doc.title.replace(/ - YouTube$/, '').trim();
	},

	/**
	 * The Room Feed's context fragment for a reply/mention row's Note:
	 * `on "Title"`, or '' with no title (deliberately no placeholder). Plain
	 * text, never a link.
	 * @param {?{videoTitle?: string}} note
	 * @returns {string}
	 */
	videoContext(note) {
		const title = note && typeof note.videoTitle === 'string' ? note.videoTitle.trim() : '';
		return title === '' ? '' : 'on "' + title + '"';
	},

	/**
	 * Tooltip for any Room Feed link that opens a video's watch page:
	 * `Watch "Title"`, falling back to `Watch this video` (mirroring the link's
	 * own "a video" label) when there is no title.
	 * @param {?string} title
	 * @returns {string}
	 */
	titleLinkTooltip(title) {
		const trimmed = typeof title === 'string' ? title.trim() : '';
		return trimmed === '' ? 'Watch this video' : 'Watch "' + trimmed + '"';
	},

	/**
	 * Render plan for one recommend System Message row; home-section.js executes
	 * it. Live vs struck comes from the item's `removed` flag: a struck line has
	 * NO link (`linkVideoId` null, the sole exception to the Feed's link rule)
	 * and instead carries a "No longer recommended" rowTooltip + visually-hidden
	 * srSuffix, since a line-through alone conveys nothing to a screen reader.
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
	 * "Watched by" attribution for one video: "You" first (if you have a
	 * record), then up to two Buddy names most-recent first, then "and N
	 * other(s)"; '' if nobody has a record. `buddiesOnly` (the Watched-By Dots
	 * tooltip) drops "You" - that's YouTube's own red Watched Bar's to tell.
	 * @param {Array<object>} progress Room read progress records (all members).
	 * @param {string} videoId
	 * @param {string} myClientId
	 * @param {Array<{clientId: string, name?: string}>} [roster] the Room roster; makes Buddy names Room-unique.
	 * @param {{buddiesOnly?: boolean}} [options]
	 * @returns {string} e.g. "You, Bob, and 1 other"
	 */
	watchedByLabel(progress, videoId, myClientId, roster, { buddiesOnly = false } = {}) {
		const latest = new Map(); // clientId -> latest record (for its name)
		for (const r of progress || []) {
			if (!r || !r.clientId || r.videoId !== videoId) continue;
			const prev = latest.get(r.clientId);
			if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.clientId, r);
		}
		const parts = [];
		if (latest.has(myClientId)) {
			if (!buddiesOnly) parts.push('You');
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
	 * A Progress Record's Watch Status (CONTEXT.md): round timestamp/duration to
	 * nearest 5%, reading "Watched" at 80%+ or the percent (floored at 5%, never
	 * 0%) below that; null with no usable duration (never renders "NaN%").
	 * @param {number} timestamp seconds into the video.
	 * @param {number} duration the video's length in seconds.
	 * @returns {?string} "Watched", a rounded percent like "45%", or null.
	 */
	watchStatus(timestamp, duration) {
		const t = Number(timestamp);
		const d = Number(duration);
		if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return null;
		const rounded = Math.round((t / d) * 20) * 5; // nearest 5%
		if (rounded >= 80) return 'Watched';
		return Math.max(rounded, 5) + '%';
	},

	/**
	 * The Watched-By Dots tooltip's rows: one per Buddy with a Progress Record
	 * (viewer excluded), newest first, same order the dots render in; the Room
	 * cap bounds this at four rows so nothing needs to collapse.
	 * @param {Array<object>} progress Room read progress records (all members).
	 * @param {string} videoId
	 * @param {string} myClientId
	 * @param {Array<{clientId: string, name?: string}>} [roster] makes names Room-unique.
	 * @returns {Array<{clientId: string, name: string, status: ?string}>}
	 */
	watchedByRows(progress, videoId, myClientId, roster) {
		const latest = new Map(); // clientId -> latest record for this video
		for (const r of progress || []) {
			if (!r || !r.clientId || r.videoId !== videoId || r.clientId === myClientId) continue;
			const prev = latest.get(r.clientId);
			if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.clientId, r);
		}
		return [...latest.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt || (a.clientId < b.clientId ? -1 : 1))
			.map((r) => ({
				clientId: r.clientId,
				name: YTB.buddyName(r.clientId, r.name, roster),
				status: YTB.watchStatus(r.timestamp, r.duration),
			}));
	},

	/**
	 * The Watched-By Dots cluster's accessible name: flat equivalent of the
	 * visual rows, so screen reader / keyboard-focus users get the same info the
	 * pointer shows.
	 * @param {Array<{name: string, status: ?string}>} rows watchedByRows output.
	 * @returns {string} '' when there are no rows.
	 */
	watchedByAriaLabel(rows) {
		if (!rows || rows.length === 0) return '';
		return 'Watched by ' + rows.map((r) => (r.status ? `${r.name} ${r.status}` : r.name)).join(', ');
	},

	/**
	 * Each viewer's "Recommended for you" grid (ADR-0007): items not added by the
	 * viewer, minus Dismissed instances, newest first. Dismiss keys on the item's
	 * server-minted id, so a re-recommend (new id) resurfaces even a previously
	 * Dismissed video.
	 * @param {Array<{id: string, videoId: string, addedBy: string, addedAt: number}>} playlist Room read items.
	 * @param {string} myClientId
	 * @param {Iterable<string>} [dismissedIds] this Room's local Dismissals (item ids).
	 * @returns {Array<object>}
	 */
	recommendedForYou(playlist, myClientId, dismissedIds) {
		const dismissed = new Set(dismissedIds || []);
		return (playlist || [])
			.filter((item) => item && item.videoId && item.addedBy !== myClientId && !dismissed.has(item.id))
			.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
	},

	/**
	 * The watch-page Recommend Control's state: the Room's authoritative
	 * `addedBy` with the pending Recommend Intent overlaid (CONTEXT.md), keeping
	 * the optimistic pill still through a racing Room read; a Buddy's addedBy
	 * outranks a pending 'mine' (a no-op recommend settles to "Recommended to
	 * you" as a correction, not a flicker).
	 * @param {{addedBy?: string, myClientId?: string, pending?: 'mine'|'absent'}} args
	 * @returns {'idle'|'added'|'recommended'}
	 */
	recommendPillState({ addedBy, myClientId, pending }) {
		const effective = pending === 'mine' ? (addedBy === undefined ? myClientId : addedBy) : pending === 'absent' ? undefined : addedBy;
		if (effective === undefined) return 'idle';
		return myClientId && effective === myClientId ? 'recommended' : 'added';
	},

	/**
	 * Has a Room read caught up with a pending Recommend Intent, so the intent
	 * can be dropped and the pill driven purely by Room data again?
	 *   'mine'   settles once ANY `addedBy` exists — mine, or the Buddy whose
	 *            item my add turned out to be a no-op onto;
	 *   'absent' settles once `addedBy` is gone.
	 * No pending intent is vacuously settled (nothing to hold).
	 * @param {{addedBy?: string, myClientId?: string, pending?: 'mine'|'absent'}} args
	 * @returns {boolean}
	 */
	recommendIntentSettled({ addedBy, myClientId: _myClientId, pending }) {
		if (pending === 'mine') return addedBy !== undefined;
		if (pending === 'absent') return addedBy === undefined;
		return true;
	},

	// --- Dismissed Recommendations (ADR-0007) ---
	// Hides one Recommendation from this viewer's grid only: local, Room-scoped, keyed
	// by item id (never reaches the backend), so a re-recommend after un-recommend
	// resurfaces. Deliberately no un-dismiss yet.

	/**
	 * The recommendation-instance ids this viewer has Dismissed in one Room.
	 * @param {string} code Room Code (already normalized).
	 * @returns {Promise<Array<string>>}
	 */
	async dismissedIds(code) {
		return roomScopedLocalLists.read('dismissedRecommendations', code);
	},

	/**
	 * Dismiss one Recommendation locally so it stays hidden across reloads;
	 * idempotent, local-only.
	 * @param {string} code Room Code (already normalized).
	 * @param {string} id the recommendation instance id.
	 * @returns {Promise<Array<string>>} the Room's updated Dismissed list.
	 */
	async dismissRecommendation(code, id) {
		if (!code || !id) return YTB.dismissedIds(code);
		return roomScopedLocalLists.update('dismissedRecommendations', code, (room) => (room.includes(id) ? room : [...room, id]));
	},

	/**
	 * Prune the Room's Dismissed set against a successful Room read (drop dead
	 * ids so the set can't grow unbounded); never against a FAILED read, whose
	 * empty playlist would resurface every Dismissed card.
	 * @param {string} code Room Code (already normalized).
	 * @param {Iterable<string>} liveIds every Playlist Item id in the read.
	 * @returns {Promise<Array<string>>} the Room's surviving Dismissed list.
	 */
	async pruneDismissed(code, liveIds) {
		if (!code) return [];
		const live = new Set(liveIds || []);
		return roomScopedLocalLists.update('dismissedRecommendations', code, (room) => room.filter((id) => live.has(id)));
	},

	// --- Unseen Mentions & Replies (ADR-0010) ---
	// A Note/Reply addressed to the viewer is Unseen (pulses its dot) until Acknowledged;
	// the seen set below is local, per-install, Room-scoped, structurally identical to a Dismiss.

	/**
	 * The Note ids whose dots pulse: each anchors an Unseen Mention
	 * (noteAddressesMe) or Unseen Reply (replyAddressesMe) not yet seen -
	 * exactly what the Room Feed surfaces. A Reaction never pulses; a Reply with
	 * no parent in the read is ignored.
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
	 * The exact ids Acknowledging one Note Dot clears: the Note itself (if it
	 * Mentions the viewer) plus every addressed Reply beneath it. Idempotent;
	 * empty for a Reaction, unknown id, or nothing addressed to the viewer.
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
		return roomScopedLocalLists.read('seenItems', code);
	},

	/**
	 * Acknowledge: persist ids into the Room's seen set so the dot never pulses
	 * again, across reloads/navigations/sessions. Idempotent, local-only.
	 * @param {string} code Room Code (already normalized).
	 * @param {Iterable<string>} ids Note/Reply ids (from acknowledgeTargets).
	 * @returns {Promise<Array<string>>} the Room's updated seen list.
	 */
	async markSeen(code, ids) {
		const additions = [...(ids || [])].filter((id) => typeof id === 'string' && id !== '');
		if (!code || additions.length === 0) return YTB.seenIds(code);
		return roomScopedLocalLists.update('seenItems', code, (room) => {
			const merged = new Set(room);
			for (const id of additions) merged.add(id);
			return merged.size === room.length ? room : [...merged];
		});
	},

	/**
	 * Prune the Room's seen set against a successful Room read so it can't grow
	 * unbounded; never against a FAILED read, whose empty arrays would
	 * resurrect every Acknowledged pulse.
	 * @param {string} code Room Code (already normalized).
	 * @param {Iterable<string>} liveIds every Note + Reply id in the read.
	 * @returns {Promise<Array<string>>} the Room's surviving seen list.
	 */
	async pruneSeen(code, liveIds) {
		if (!code) return [];
		const live = new Set(liveIds || []);
		return roomScopedLocalLists.update('seenItems', code, (room) => room.filter((id) => live.has(id)));
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
	 * Whether a Note is addressed to the viewer: a FOREIGN Note whose mentions
	 * include their Client ID (ADR-0006). The one rule buildFeed and
	 * unseenNoteIds both consume, so they never drift.
	 * @param {?{clientId?: string, mentions?: Array<string>}} note
	 * @param {string} myClientId
	 * @returns {boolean}
	 */
	noteAddressesMe(note, myClientId) {
		if (!note || note.clientId === myClientId) return false;
		return Array.isArray(note.mentions) && note.mentions.includes(myClientId);
	},

	/**
	 * Whether a Reply is addressed to the viewer: FOREIGN, and either under the
	 * viewer's own Note or Mentioning them (shared with noteAddressesMe).
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
	 *   - Notes/Replies whose `mentions` include the viewer (deduped if both apply);
	 *   - recommend System Messages from `added` Events, shown to every member as
	 *     "X recommended Title" (or "You recommended ... to the Room", `own: true`);
	 *     each carries `removed` when superseded by a newer add or un-recommended
	 *     (struck through; un-recommends emit no event);
	 *   - Watch Notices ("X started watching Title"), recommender-only, one per
	 *     (Buddy, video) they recommended, best-effort ordered by updatedAt.
	 * Sorted oldest -> newest and grouped under day dividers; no read/unread state.
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
			// Shared replyAddressesMe rule (own writes are never news); Unseen
			// derivation uses the same predicate.
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
		// Recommend System Messages: only `added` events count (un-recommends emit none).
		// `removed` (ADR-0007, 2026-07-09) is per-event: true if a newer `added` event exists
		// for the same videoId (superseded - a re-add is only possible after a delete) or the
		// videoId is no longer live, so a re-recommend revives only its own fresh line.
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
		// Watch Notices: one per Buddy with a Progress Record for a video the viewer
		// recommended; title from the Playlist Item, not the Progress Record.
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
	 * Trim a day-grouped Feed to its newest `limit` items (the "Show more" reveal
	 * window); item-level not day-level, so a partly revealed day keeps its
	 * divider with only its newest tail, and an empty day is dropped. Pure -
	 * never mutates the input.
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
	 * Normalize a Room Code to its canonical slug (lowercase, drop leading "the ",
	 * whitespace -> hyphens, collapse/trim stray hyphens) so the pretty label and
	 * typed/pasted form pair, e.g. "The Silly Otters" -> "silly-otters".
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

	// Fixed colors for contrast on light popup/feed surfaces and YouTube's dark
	// player; at most four foreign Buddies, so spares remain.
	BUDDY_COLORS: ['#00a6d6', '#FFB812', '#8649d6', '#00a86b', '#ff8400', '#d936c7', '#d94141', '#4651e5'],
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
	 * Stable 32-bit hash of a Client ID, so everything keyed off a Buddy (color,
	 * fallback name) stays stable across videos, thumbnails, the popup, and
	 * every viewer.
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
	 * The Buddy Color as TEXT ink on an opaque card surface: raw fills miss WCAG
	 * AA as small text, so blend toward the theme ink (--ytb-ink); over-video
	 * text, dots, markers, and swatches keep the raw buddyColor.
	 * @param {string} clientId
	 * @param {string} [code]
	 * @returns {string} a CSS color-mix() expression
	 */
	buddyTextColor(clientId, code = YTB._activeRoomCode) {
		return `color-mix(in oklab, ${YTB.buddyColor(clientId, code)} 50%, var(--ytb-ink))`;
	},

	/**
	 * Base display label for a Buddy without Room context: trimmed Display Name,
	 * else a stable "<Adjective> Buddy" from their Client ID. Collisions are
	 * possible, so user-facing code goes through buddyName with a roster to
	 * disambiguate.
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
	 * Map every Client ID in a roster to a Room-unique label: base labels from
	 * baseBuddyName, collisions ordered by Client ID with each successive
	 * duplicate gaining a "Very " prefix ("Silly Buddy" / "Very Silly Buddy" /
	 * ...). Deterministic across surfaces and viewers; applies to real names too.
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
	 * Display label for a Buddy: the base label without a roster, or the
	 * Room-unique label (disambiguateNames) with one. FOREIGN records only - you
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
	 * Reduce `{ progress, presence, notes }` into a Room view from my
	 * perspective: a Buddy is any FOREIGN clientId, preferring their latest
	 * Progress Record over a presence-only row. Capped at MAX_MEMBERS distinct
	 * Client IDs.
	 * @param {{progress: Array<object>, presence: Array<object>, notes?: Array<object>}} records
	 * @param {string} myClientId
	 * @returns {{buddies: Array<object>, iAmMember: boolean, locked: boolean}}
	 *   buddies newest-first by updatedAt; iAmMember whether I appear under the code;
	 *   locked whether the Room is full of OTHERS with me the rejected 6th (render nothing).
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

		// Distinct OTHERS; 5 with no membership of my own = a full Room I'd be the
		// locked-out 6th of.
		let foreignCount = 0;
		for (const id of memberIds) if (id !== myClientId) foreignCount++;
		const locked = !iAmMember && foreignCount >= YTB.MAX_MEMBERS;

		return { buddies, iAmMember, locked };
	},
};

// The ONE `buddyColors` storage subscription: shared.js owns the cache refresh (load-order
// independent) and rebroadcasts `ytb:buddy-colors` for pages to repaint (mirrors renderer.js's
// `ytb:room-data`). The `document` guard lets the workerd test harness just refresh the cache.
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local' || !changes.buddyColors) return;
	YTB._buddyColors = changes.buddyColors.newValue || {};
	if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('ytb:buddy-colors'));
});

// The ONE Controls Hold (CONTEXT.md), on the YTB global so notes.js and composer.js share the
// same refcount regardless of load order: the chrome stays awake until the last surface releases.
YTB.controlsHold = YTB.createControlsHold({
	dispatch: (tick) => YTB.nudgePlayerControls(tick),
});

window.YTB = YTB;
