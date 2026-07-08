// extension/renderer.js
//
// The renderer: draws the Buddies' Progress Records — a colored marker per Buddy
// on the active video's player progress bar, and a segmented progress bar on
// thumbnails across the home/recommended/search/listing surfaces. Display-only
// (no click-to-seek).
//
// It is also the Room's single poller: every refresh rebroadcasts the fetched
// Notes + Replies as `ytb:room-data` for notes.js (which owns ALL Note
// presentation — timeline dots, Note Previews, the Expanded Note, and Playback
// Notifications). This file renders no Note UI itself.
//
// Loaded as the 3rd content-script file (after shared.js + reporter.js, before
// content.js), so `window.YTB` exists and our `ytb:*` listeners are attached
// synchronously at top level BEFORE content.js (loaded last) fires the initial
// ytb:navigate. Content scripts are NOT ES modules — communicate only via the
// window.YTB global and `document` events (no import/export). See ADR-0001
// (docs/adr/0001-content-script-owned-sync.md).
//
// We are a pure CONSUMER of navigation/mutation: content.js owns the single
// observer and emits ytb:navigate / ytb:mutation; we never detect either.
//
// "Buddy" filter: a record is a Buddy's iff record.clientId !== myClientId. A
// Room Code is one Room of up to YTB.MAX_MEMBERS people; when this install is
// the locked-out 6th (Room full), we draw nothing. Reads happen regardless of
// the Sharing toggle — Sharing only gates POSTs.

(function () {
	'use strict';

	// --- constants ---
	// Each Buddy gets a stable color from YTB.buddyColor (set inline per element);
	// the CSS defaults below only matter before a color is assigned.

	const MARKER_CLASS = 'ytb-watch-marker';
	const TOOLTIP_CLASS = 'ytb-watch-tooltip';
	const THUMB_BAR_CLASS = 'ytb-thumb-bar'; // segmented-bar container
	const THUMB_SEG_CLASS = 'ytb-thumb-seg'; // one colored segment per Buddy
	const TOAST_WRAP_CLASS = 'ytb-toast-wrap'; // fixed stack container
	const TOAST_CLASS = 'ytb-toast'; // one "<Buddy> joined" toast
	const STYLE_ID = 'ytb-renderer-style';
	const PRESENCE_POLL_MS = 60_000; // re-GET cadence for live markers + presence

	// --- state ---
	let myClientId = null; // memoized; my own records are filtered out
	let buddyByVideoId = new Map(); // videoId -> Buddy ProgressRecord[] (latest per Buddy)
	let activeRoomCode = '';
	let currentVideoId = null; // active /watch video, or null off a watch page
	let refreshToken = 0; // guards against out-of-order async refreshes
	let knownBuddyIds = new Set(); // foreign clientIds seen last refresh (toast diffing)
	let baselineReady = false; // skip toasts on the very first read (no false "joined")
	let pollTimer = null;

	// Buddy Progress Visibility (Settings): while hidden, draw neither markers
	// nor thumbnail bars — but keep polling and rebroadcasting ytb:room-data
	// (notes, the popup roster, presence, and the home section are unaffected).
	let buddyProgressHidden = false;

	injectStyle();

	YTB.getSettings().then((settings) => {
		buddyProgressHidden = settings.buddyProgressHidden;
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	// ---------------------------------------------------------------------------
	// Data: fetch + cache the Buddies' records.
	// ---------------------------------------------------------------------------

	/**
	 * GET every record under the configured Room Code and index the Buddies'
	 * (foreign clientId) by videoId — one latest record per Buddy per video. Bails
	 * to an empty cache when there is no code (Unpaired) or when this install is
	 * the locked-out 6th member (Room full — draw nothing). Server-side TTL
	 * already drops records older than 14 days, so no age filter is needed here.
	 */
	async function refresh() {
		if (!YTB.isContextActive()) return;
		const { code } = await YTB.getConfig();
		if (!YTB.isContextActive()) return;
		if (!code) {
			buddyByVideoId = new Map();
			activeRoomCode = '';
			resetPresenceBaseline();
			broadcastRoomData(null, false);
			return;
		}
		myClientId = myClientId || (await YTB.ensureClientId());
		if (!YTB.isContextActive()) return;
		activeRoomCode = code;
		const records = await YTB.getRecords(code);
		const view = YTB.roomView(records, myClientId);
		await YTB.syncBuddyColors(
			code,
			view.buddies.map((buddy) => buddy.clientId),
			records.ok,
		);
		if (!YTB.isContextActive()) return;

		// Toast new arrivals (presence OR progress). Diff against last refresh; the
		// first read just seeds the baseline so existing Buddies never "join".
		notePresence(view.buddies);

		// Locked out of a full Room: I'm not a member and 5 others already are.
		if (view.locked) {
			buddyByVideoId = new Map();
			broadcastRoomData(null, true);
			return;
		}

		// videoId -> (clientId -> latest record), then flattened to arrays. Presence
		// rows have no videoId, so they never produce a marker (only a toast/roster).
		const byVideo = new Map();
		for (const r of records.progress) {
			if (!r || r.clientId === myClientId || !r.videoId) continue;
			let perBuddy = byVideo.get(r.videoId);
			if (!perBuddy) {
				perBuddy = new Map();
				byVideo.set(r.videoId, perBuddy);
			}
			const prev = perBuddy.get(r.clientId);
			if (!prev || r.updatedAt > prev.updatedAt) perBuddy.set(r.clientId, r);
		}
		const next = new Map();
		for (const [videoId, perBuddy] of byVideo) {
			next.set(videoId, Array.from(perBuddy.values()));
		}
		buddyByVideoId = next;

		broadcastRoomData(records, false);
	}

	// Hand every refreshed Room read to the other modules: notes.js (the sole
	// Note-presentation owner) reconciles the Video Timeline, Reply counts, and
	// Playback Notifications; home-section.js renders the Room Home Section
	// (Feed + Recommended for you); mentions.js keeps the roster for
	// @-autocomplete; playlist-add.js reflects the pill's recommend state. None of them
	// polls the Room itself — this stays the single poller. Pass `null` records
	// for the empty broadcast (no code, or locked out of a full Room).
	function broadcastRoomData(records, locked) {
		const r = records || {};
		document.dispatchEvent(
			new CustomEvent('ytb:room-data', {
				detail: {
					notes: r.notes || [],
					replies: r.replies || [],
					progress: r.progress || [],
					presence: r.presence || [],
					playlist: r.playlist || [],
					events: r.events || [],
					roomCode: activeRoomCode,
					myClientId,
					locked: Boolean(locked),
				},
			}),
		);
	}

	// Reset the toast baseline when there is no code (so re-joining later doesn't
	// replay every existing member as a fresh "joined").
	function resetPresenceBaseline() {
		knownBuddyIds = new Set();
		baselineReady = false;
	}

	// Diff the current foreign Buddies against the last seen set; toast any new
	// clientId once the baseline has been established. `buddies` already excludes
	// me and dedups by clientId (presence-only Buddies included).
	function notePresence(buddies) {
		const current = new Set();
		for (const b of buddies) {
			current.add(b.clientId);
			if (baselineReady && !knownBuddyIds.has(b.clientId)) {
				showToast(YTB.buddyName(b.clientId, b.name) + ' joined');
			}
		}
		knownBuddyIds = current;
		baselineReady = true;
	}

	// ---------------------------------------------------------------------------
	// Watch page: one colored marker per Buddy on the player progress bar.
	// ---------------------------------------------------------------------------

	/**
	 * Draw (or refresh) a marker per Buddy on `.ytp-progress-bar` for `videoId`,
	 * each at the Buddy's position in that Buddy's color, with a hover tooltip.
	 * No-op when the bar isn't built yet (the player initializes async —
	 * ytb:mutation re-invokes us until it is). Keyed by clientId so markers
	 * survive re-renders (no flicker mid-hover); Buddies that left are removed.
	 * Overlapping positions are allowed to overlap.
	 * @param {string|null} videoId
	 */
	function renderWatchMarker(videoId) {
		const bar = document.querySelector('.ytp-progress-bar');
		if (!bar) return; // player not ready yet — a later ytb:mutation retries

		// Hidden Buddy Progress leaves `desired` empty, so the reconciliation
		// below strips existing markers (and re-grows them all when re-shown).
		const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;
		const desired = new Map(); // clientId -> { fraction, record }
		if (records) {
			for (const r of records) {
				const fraction = positionFraction(r);
				if (fraction !== null) desired.set(r.clientId, { fraction, record: r });
			}
		}

		// Reconcile existing markers by clientId: keep the ones still wanted, drop
		// the rest. Index them rather than querying per id, so an unusual clientId
		// can never form a bad attribute selector.
		const existing = new Map();
		for (const marker of bar.querySelectorAll(':scope > .' + MARKER_CLASS)) {
			const cid = marker.dataset.ytbCid;
			if (desired.has(cid)) existing.set(cid, marker);
			else marker.remove();
		}
		if (desired.size === 0) return;

		// The bar must establish a positioning context for the absolute markers.
		if (getComputedStyle(bar).position === 'static') {
			bar.style.position = 'relative';
		}

		for (const [cid, { fraction, record }] of desired) {
			let marker = existing.get(cid);
			if (!marker) {
				marker = document.createElement('div');
				marker.className = MARKER_CLASS;
				marker.dataset.ytbCid = cid;
				const tooltip = document.createElement('div');
				tooltip.className = TOOLTIP_CLASS;
				marker.appendChild(tooltip);
				bar.appendChild(marker);
			}
			marker.style.left = (fraction * 100).toFixed(3) + '%';
			marker.style.background = YTB.buddyColor(cid);
			const who = YTB.buddyName(record.clientId, record.name);
			marker.querySelector('.' + TOOLTIP_CLASS).textContent = who + ' · @' + YTB.formatTime(record.timestamp);
		}
	}

	// ---------------------------------------------------------------------------
	// Thumbnails: a single segmented bar per tile, one colored band per Buddy.
	// Bands are sorted by position; each Buddy owns [previous Buddy's pos .. own
	// pos] in their color. So with Alice @ 30% and Bob @ 70%, 0–30% is Alice's
	// color and 30–70% is Bob's, and the fill stops at the furthest Buddy.
	// ---------------------------------------------------------------------------

	/**
	 * Overlay the segmented Buddy bar on every thumbnail tile whose video matches.
	 * Idempotent + recycle-safe: YouTube reuses tile DOM nodes for different
	 * videos as you scroll, so each pass re-keys the bar to the tile's CURRENT
	 * videoId and only rebuilds its bands when the video or the positions change
	 * (a signature guard) — frequent ytb:mutation passes never tear down a
	 * tooltip mid-hover.
	 */
	function renderThumbnails() {
		const anchors = document.querySelectorAll('a[href*="/watch?v="]');
		for (const anchor of anchors) {
			// Decorate only thumbnail anchors — the ones wrapping the tile image — so
			// we never draw a bar across a video-title link. The image check is
			// surface-agnostic: it matches both the classic `a#thumbnail` tiles and
			// the newer `yt-lockup-view-model` tiles, whose anchors differ.
			if (!anchor.querySelector('img')) continue;

			const videoId = videoIdFromHref(anchor.getAttribute('href'));
			// Hidden Buddy Progress removes every tile's bar via the empty-segments
			// branch below.
			const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;

			// One band per Buddy with a computable position, sorted ascending. The
			// clientId tiebreak keeps equal-position bands deterministic.
			const segments = [];
			if (records) {
				for (const r of records) {
					const fraction = positionFraction(r);
					if (fraction !== null) {
						segments.push({ cid: r.clientId, fraction, record: r });
					}
				}
				segments.sort((a, b) => a.fraction - b.fraction || (a.cid < b.cid ? -1 : 1));
			}

			let container = anchor.querySelector(':scope > .' + THUMB_BAR_CLASS);

			if (segments.length === 0) {
				if (container) container.remove();
				delete anchor.dataset.ytbVid;
				continue;
			}

			// Rebuild bands only when the video or its positions changed.
			const sig = videoId + '|' + segments.map((s) => s.cid + ':' + s.fraction.toFixed(3)).join(',');
			if (container && container.dataset.ytbSig === sig) continue;

			if (!container) {
				// The anchor must establish a positioning context for the absolute bar.
				if (getComputedStyle(anchor).position === 'static') {
					anchor.style.position = 'relative';
				}
				container = document.createElement('div');
				container.className = THUMB_BAR_CLASS;
				anchor.appendChild(container);
			}
			container.textContent = ''; // clear old bands before rebuilding
			let prev = 0;
			for (const s of segments) {
				const seg = document.createElement('div');
				seg.className = THUMB_SEG_CLASS;
				seg.style.left = (prev * 100).toFixed(3) + '%';
				seg.style.width = ((s.fraction - prev) * 100).toFixed(3) + '%';
				seg.style.background = YTB.buddyColor(s.cid);
				const tooltip = document.createElement('div');
				tooltip.className = TOOLTIP_CLASS;
				const who = YTB.buddyName(s.record.clientId, s.record.name);
				tooltip.textContent = who + ' · @' + YTB.formatTime(s.record.timestamp);
				seg.appendChild(tooltip);
				container.appendChild(seg);
				prev = s.fraction;
			}
			container.dataset.ytbSig = sig;
			anchor.dataset.ytbVid = videoId;
		}
	}

	// ---------------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------------

	/**
	 * The clamped [0,1] watched fraction for a record, or null if it can't be
	 * computed (non-finite / non-positive duration).
	 * @param {{timestamp: number, duration: number}} record
	 * @returns {number|null}
	 */
	function positionFraction(record) {
		const t = Number(record.timestamp);
		const d = Number(record.duration);
		if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return null;
		return Math.max(0, Math.min(1, t / d));
	}

	/** Parse the `v=` videoId out of a /watch href, or null. */
	function videoIdFromHref(href) {
		if (!href) return null;
		try {
			const u = new URL(href, location.href);
			return u.pathname === '/watch' ? u.searchParams.get('v') : null;
		} catch {
			return null;
		}
	}

	/**
	 * Show a small auto-dismissing toast (e.g. "Silly Buddy joined"). Stacks in a
	 * fixed bottom-right container; each toast fades out after ~4s. Styled via the
	 * injected renderer stylesheet.
	 * @param {string} text
	 */
	function showToast(text) {
		let wrap = document.querySelector('.' + TOAST_WRAP_CLASS);
		if (!wrap) {
			wrap = document.createElement('div');
			wrap.className = TOAST_WRAP_CLASS;
			(document.body || document.documentElement).appendChild(wrap);
		}
		const toast = document.createElement('div');
		toast.className = TOAST_CLASS;
		toast.textContent = text;
		wrap.appendChild(toast);
		requestAnimationFrame(() => toast.classList.add('show'));
		setTimeout(() => {
			toast.classList.remove('show');
			setTimeout(() => toast.remove(), 250);
		}, 4000);
	}

	/** Inject the renderer's CSS once (no separate stylesheet file). */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const fallback = YTB.BUDDY_COLORS[0]; // before a per-Buddy color is set
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      .${MARKER_CLASS} {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 3px;
        margin-left: -1px;
        background: ${fallback};
        z-index: 40;
        cursor: default;
      }
      .${TOOLTIP_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        transform: translateX(-50%);
        padding: 3px 6px;
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font-size: 12px;
        line-height: 1.2;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.1s;
        z-index: 1;
      }
      .${MARKER_CLASS}:hover .${TOOLTIP_CLASS},
      .${THUMB_SEG_CLASS}:hover .${TOOLTIP_CLASS} {
        opacity: 1;
      }
      .${THUMB_BAR_CLASS} {
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        height: 4px;
        pointer-events: none;
        z-index: 2000;
      }
      .${THUMB_SEG_CLASS} {
        position: absolute;
        top: 0;
        bottom: 0;
        background: ${fallback};
        pointer-events: auto;
        cursor: default;
      }
      .${TOAST_WRAP_CLASS} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483000;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .${TOAST_CLASS} {
        max-width: 280px;
        padding: 10px 14px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Arial, sans-serif;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.25s, transform 0.25s;
      }
      .${TOAST_CLASS}.show {
        opacity: 1;
        transform: translateY(0);
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer of content.js's ytb:* events. Registered
	// synchronously so the initial ytb:navigate (fired by content.js, loaded
	// last) is received.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', async (e) => {
		if (!YTB.isContextActive()) return;
		currentVideoId = (e.detail && e.detail.videoId) || null;
		const token = ++refreshToken;
		await refresh();
		if (token !== refreshToken) return; // a newer navigate superseded this one
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		// The feed lazy-loaded more tiles (and/or the player finished building).
		// Use the cached records — no re-GET. Re-apply the markers too, since the
		// progress bar may have only just appeared after the last navigate.
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		let touched = false;
		if (changes.buddyColors) {
			YTB._buddyColors = changes.buddyColors.newValue || {};
			touched = true;
		}
		if (changes.buddyProgressHidden) {
			// Live Buddy Progress Visibility flip from the popup Settings.
			buddyProgressHidden = changes.buddyProgressHidden.newValue === true;
			touched = true;
		}
		if (!touched) return;
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	// Live updates: re-GET every ~60s so a Buddy who joins or moves shows up (and
	// arrival toasts fire) without a navigation. ~1 GET/min per open tab. Uses the
	// same refreshToken guard so a poll can't clobber a fresher navigate render.
	pollTimer = setInterval(async () => {
		if (!YTB.isContextActive()) return;
		const token = ++refreshToken;
		await refresh();
		if (token !== refreshToken) return;
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	}, PRESENCE_POLL_MS);

	YTB.onContextInvalidated(() => {
		refreshToken++;
		if (pollTimer !== null) clearInterval(pollTimer);
		pollTimer = null;
	});
})();
