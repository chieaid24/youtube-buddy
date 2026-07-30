// extension/content/shared.js
// Core of the window.YTB global (ADR-0001: classic scripts, no ES modules; the
// popup and every content script talk only via window.YTB). The shared-*.js
// siblings extend this object — load order lives in manifest.json/popup.html.

const YTB = {
	// A Chrome extension reload/update revokes an already-injected content
	// script's API access; treat that one error as terminal for the stale script.
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

	// Room-scoped local-list persistence for Dismissals and seen ids:
	// { [storageKey]: { [roomCode]: string[] } }. Callers own input filtering.
	_roomLists: {
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
	},

	// Local dev backend; update alongside manifest.json host_permissions before deploying.
	BACKEND_URL: 'http://localhost:8787',

	// Mirrors backend MAX_MEMBERS; the client uses it to detect a full Room (roomView).
	MAX_MEMBERS: 5,

	// Keep in lockstep with backend NOTE_EMOJIS (server rejects anything else).
	NOTE_EMOJIS: ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}'],

	// Mirror the backend caps (Reply cap is best-effort under KV).
	NOTE_MAX_CHARS: 100,
	MAX_REPLIES: 10,
	MAX_PLAYLIST_ITEMS: 30,

	// The Expanded Note omits "Go here" within this many seconds of the Note's
	// moment; independent of the natural-crossing delta in notes.js.
	GO_HERE_NEAR_SECONDS: 2,

	// clientId is "" until ensureClientId() mints one.
	async getConfig() {
		const stored = await YTB._storageGet(['name', 'code', 'clientId', 'sharing']);
		return {
			name: stored.name ?? '',
			code: stored.code ?? '',
			clientId: stored.clientId ?? '',
			sharing: stored.sharing ?? true,
		};
	},

	// Merge-write { name?, code?, sharing? }; clientId is owned by ensureClientId.
	async setConfig(partial) {
		const next = {};
		for (const key of ['name', 'code', 'sharing']) {
			if (key in partial) next[key] = partial[key];
		}
		await YTB._storageSet(next);
	},

	// Room Home Section visibility: per install, absent means visible.
	async getHomeSectionHidden() {
		const { homeSectionHidden } = await YTB._storageGet('homeSectionHidden');
		return homeSectionHidden === true;
	},

	async setHomeSectionHidden(hidden) {
		return await YTB._storageSet({ homeSectionHidden: hidden === true });
	},

	// Room Feed row click -> notes.js handoff (ADR-0010): stored (not an in-memory
	// event) so it survives SPA navigation and full reloads; the TTL expires a
	// stale click.
	PENDING_ARRIVAL_TTL_MS: 30_000,

	// Window after a Room Feed arrival during which a video `play` is autoplay
	// churn (re-pause), not the viewer's resume; see YTB.playAction.
	PANEL_LOAD_GRACE_MS: 4_000,
	_arrivalGraceUntil: 0,

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

	// One slot: a newer Room Feed click replaces an unconsumed older one.
	async setPendingArrival(videoId) {
		const id = videoId ? String(videoId) : '';
		if (!id) return false;
		return await YTB._storageSet({
			pendingArrival: { videoId: id, at: Date.now() },
		});
	},

	// null when absent, malformed, or past its TTL.
	async getPendingArrival() {
		const { pendingArrival } = await YTB._storageGet('pendingArrival');
		if (!pendingArrival || !pendingArrival.videoId) return null;
		if (Date.now() - (Number(pendingArrival.at) || 0) > YTB.PENDING_ARRIVAL_TTL_MS) return null;
		return pendingArrival;
	},

	async clearPendingArrival() {
		return await YTB._storageSet({ pendingArrival: null });
	},

	// Theme Preference legal values (ADR-0008/0009).
	THEMES: ['light', 'dark', 'system'],

	// Notification Position's four edges (Playback Notifications, notes.js).
	NOTIFICATION_EDGES: ['top', 'bottom', 'left', 'right'],

	// Read every Settings key, coercing unset/junk values to defaults; Room Home
	// Section has its own getHomeSectionHidden seam.
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

	// Merge-write Settings, validating each key so stored state round-trips
	// getSettings exactly (illegal values dropped, flags coerced to booleans).
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

	// Theme Preference -> data-theme (ADR-0008/0009): forced light/dark wins;
	// under Auto mirror the page's darkness, or null off-page (popup falls back
	// to the OS media query).
	themeMarker(preference, pageDark) {
		if (preference === 'light' || preference === 'dark') return preference;
		if (pageDark === true) return 'dark';
		if (pageDark === false) return 'light';
		return null;
	},

	// One shared, auto-dismissing page toast; theme.js owns the styles.
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

	// Return the existing Client ID, or mint one ONCE (8 hex chars) and persist
	// it; stable for the life of the install.
	async ensureClientId() {
		const { clientId } = await YTB._storageGet('clientId');
		if (clientId) return clientId;
		if (!YTB.isContextActive()) return '';
		const bytes = new Uint8Array(4);
		crypto.getRandomValues(bytes);
		const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		await YTB._storageSet({ clientId: id });
		return id;
	},

	// Seconds -> "M:SS" (or "H:MM:SS" past an hour), e.g. 412 -> "6:52".
	formatTime(seconds) {
		const total = Math.max(0, Math.floor(Number(seconds) || 0));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const ss = String(s).padStart(2, '0');
		if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
		return `${m}:${ss}`;
	},

	// Relative age label ("just now", "8 min ago", ...), rounded down to the
	// largest useful unit; UI copy prefixes "Posted ".
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

	// User-facing copy for a failed write, keyed by the server's machine-readable
	// category (never its prose); unknown categories fall back to a generic retry.
	errorCopy(category, action) {
		if (category === 'network') return "Can't reach the backend. Check your connection and try again.";
		if (category === 'reply_cap') return 'This note already has 10 replies.';
		if (category === 'room_full') return "This Room is full, so you can't post here.";
		if (category === 'missing_parent') return 'This note is no longer available.';
		return `We couldn't post your ${action}. Try again.`;
	},
};

window.YTB = YTB;
