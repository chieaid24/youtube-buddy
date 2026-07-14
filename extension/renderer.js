// extension/renderer.js
//
// The renderer: draws the Buddies' Progress Records — a colored marker per Buddy
// on the active video's player progress bar, and the Watched-By Dots (a
// top-left cluster of flat dots in the Buddy Colors, one per Buddy with a
// Progress Record for that video — presence only, no fraction) inside
// thumbnail boxes across the home/recommended/search/listing surfaces.
// Display-only (no click-to-seek).
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
	const THUMB_DOTS_CLASS = 'ytb-thumb-dots'; // Watched-By Dots cluster on a thumbnail
	const THUMB_DOT_CLASS = 'ytb-thumb-dot'; // one flat Buddy-colored dot
	const STYLE_ID = 'ytb-renderer-style';
	const PRESENCE_POLL_MS = 60_000; // re-GET cadence for live markers + presence

	// The dots' inset from the thumbnail's top-left corner, and their geometry.
	const DOTS_INSET = 8;
	const DOT_SIZE = 8;
	const DOT_GAP = 4;

	// --- state ---
	let myClientId = null; // memoized; my own records are filtered out
	let buddyByVideoId = new Map(); // videoId -> Buddy ProgressRecord[] (latest per Buddy)
	let roster = []; // full Room roster (incl. me), for Room-unique Buddy labels
	let activeRoomCode = '';
	let currentVideoId = null; // active /watch video, or null off a watch page
	let refreshToken = 0; // guards against out-of-order async refreshes
	let knownBuddyIds = new Set(); // foreign clientIds seen last refresh (toast diffing)
	let baselineReady = false; // skip toasts on the very first read (no false "joined")
	let pollTimer = null;
	let readFailures = 0; // consecutive failed Room reads, folded via YTB.connectionState
	let connectionLost = false; // failures >= 2 — rides every ytb:room-data broadcast

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
	 * the locked-out 6th member (Room full — draw nothing). A FAILED read instead
	 * retains the previous cache untouched (Connection Lost: markers stay as last
	 * seen) while still broadcasting. Server-side TTL already drops records older
	 * than 14 days, so no age filter is needed here.
	 */
	async function refresh() {
		if (!YTB.isContextActive()) return;
		const { code } = await YTB.getConfig();
		if (!YTB.isContextActive()) return;
		if (!code) {
			buddyByVideoId = new Map();
			roster = [];
			activeRoomCode = '';
			readFailures = 0; // Unpaired: nothing is polled, so nothing can be "lost"
			connectionLost = false;
			resetPresenceBaseline();
			broadcastRoomData(null, false);
			return;
		}
		myClientId = myClientId || (await YTB.ensureClientId());
		if (!YTB.isContextActive()) return;
		activeRoomCode = code;
		const records = await YTB.getRecords(code);
		const conn = YTB.connectionState(readFailures, records.ok);
		readFailures = conn.failures;
		connectionLost = conn.lost;
		if (!records.ok) {
			// A failed read is not truth: retain the previous cache, roster, and
			// toast baseline exactly as last rendered — markers and thumbnail bars
			// stay where they were through a blip or outage (no on-video indicator;
			// see Connection Lost, PRD #137). Only the broadcast goes out, so
			// consumers still hear about the failure and its connectionLost flag.
			broadcastRoomData(records, false);
			return;
		}
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
					// Whether this broadcast carries a SUCCESSFUL Room read. A failed GET
					// still broadcasts (with empty arrays) so consumers reconcile, but
					// they must not treat the emptiness as truth — notes.js only prunes
					// the Unseen seen-set (ADR-0010) against an ok read.
					ok: Boolean(r.ok),
					// Connection Lost (>= 2 consecutive failed reads, YTB.connectionState):
					// carried on EVERY broadcast so consumers track both onset and
					// recovery without owning a failure counter of their own.
					connectionLost,
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
				YTB.toast(YTB.buddyName(b.clientId, b.name, roster) + ' joined');
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
		const desired = new Map(); // clientId -> record
		if (records) {
			for (const r of records) {
				if (hasPosition(r)) desired.set(r.clientId, r);
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

		// Place through YouTube's own chapter geometry (#159), re-measured here so
		// a resize, theater/fullscreen, or late-arriving chapter DOM re-aligns every
		// marker on the next render.
		const segments = YTB.barSegments(bar);

		for (const [cid, record] of desired) {
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
			marker.style.left = YTB.timeToX(segments, record.timestamp, record.duration).toFixed(2) + 'px';
			marker.style.background = YTB.buddyColor(cid);
			const who = YTB.buddyName(record.clientId, record.name, roster);
			marker.querySelector('.' + TOOLTIP_CLASS).textContent = who + ' @' + YTB.formatTime(record.timestamp);
		}
	}

	// ---------------------------------------------------------------------------
	// Thumbnails: Watched-By Dots — a top-left cluster of flat dots inside each
	// tile's thumbnail box, one dot per Buddy who has a Progress Record for that
	// video, ordered most-recent-first. A dot means only "this Buddy has a
	// record" — no fraction, no timestamp — and the viewer is never included
	// (YouTube's own red Watched Bar already tells the viewer's state). Hovering
	// or keyboard-focusing the cluster shows one dark "Watched by <names>"
	// tooltip (the Buddies-only watchedByLabel).
	//
	// YouTube-thumbnail-DOM fragility is deliberately contained in this section
	// (as playlist-add.js and home-toggle.js do for the menu and guide DOM).
	// ---------------------------------------------------------------------------

	// YouTube's hover-autoplay inline preview host. When the preview is a
	// document-level overlay covering the tile, the in-box cluster is buried
	// under a foreign stacking context no z-index of ours can beat — so the
	// cluster is mirrored INTO the visible preview host (and removed with it).
	const PREVIEW_HOST_SELECTOR = 'ytd-video-preview';

	/**
	 * The tile's real thumbnail box — the element the Watched-By Dots must never
	 * escape. On lockup tiles (`yt-lockup-view-model`) the `/watch` anchor is
	 * WIDER AND TALLER than the image, so the cluster anchors to the nested
	 * `yt-thumbnail-view-model` (already `position: relative; overflow: hidden`
	 * and exactly the image box). Classic `a#thumbnail` tiles ARE their image
	 * box, so the anchor stands.
	 * @param {Element} anchor
	 * @returns {Element}
	 */
	function thumbBoxFor(anchor) {
		return anchor.querySelector('yt-thumbnail-view-model') || anchor;
	}

	/**
	 * Overlay the Watched-By Dots on every thumbnail tile whose video has at
	 * least one Buddy Progress Record. Idempotent + recycle-safe: YouTube reuses
	 * tile DOM nodes for different videos as you scroll, so each pass re-keys
	 * the cluster to the tile's CURRENT videoId and only rebuilds its dots when
	 * the video or the watcher set changes (a signature guard) — frequent
	 * ytb:mutation passes never tear down a tooltip mid-hover. Dot COLORS are
	 * repainted every pass: a Buddy Color re-assignment changes no ids, so it
	 * must never be short-circuited by the signature.
	 */
	function renderThumbnails() {
		const anchors = document.querySelectorAll('a[href*="/watch?v="]');
		for (const anchor of anchors) {
			// Decorate only thumbnail anchors — the ones wrapping the tile image — so
			// we never draw dots on a video-title link. The image check is
			// surface-agnostic: it matches both the classic `a#thumbnail` tiles and
			// the newer `yt-lockup-view-model` tiles, whose anchors differ.
			if (!anchor.querySelector('img')) continue;

			// Our own Recommended-for-you cards keep their below-card text label
			// ("Watched by ..."); dots there would double-label the same info.
			if (anchor.closest('#ytb-home-section')) continue;

			// Anchors inside a hover-autoplay preview host belong to
			// renderPreviewDots below — decorating both would double the dots.
			if (anchor.closest(PREVIEW_HOST_SELECTOR)) continue;

			const videoId = videoIdFromHref(anchor.getAttribute('href'));
			// Hidden Buddy Progress removes every tile's dots via the null branch.
			const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;

			// The cluster lives inside the thumbnail box, itself inside the anchor —
			// one anchor-scoped lookup finds it wherever the box resolved to.
			let cluster = anchor.querySelector('.' + THUMB_DOTS_CLASS);

			if (!records || records.length === 0) {
				if (cluster) cluster.remove();
				continue;
			}

			const box = thumbBoxFor(anchor);
			if (cluster && !box.contains(cluster)) {
				// The tile hydrated its real thumbnail box after the cluster attached
				// to the anchor — rebuild inside the right parent.
				cluster.remove();
				cluster = null;
			}

			renderDotsCluster(box, cluster, videoId, records);
		}

		renderPreviewDots();
	}

	/**
	 * Build (or reconcile) one Watched-By Dots cluster inside `box`: one flat
	 * dot per Buddy record, newest first, plus the single dark tooltip. Shared
	 * by the per-tile pass and the preview mirror.
	 * @param {Element} box the positioning parent the cluster must stay inside
	 * @param {?Element} cluster the existing cluster in `box`, if any
	 * @param {string} videoId
	 * @param {Array<object>} records this video's Buddy records (latest per Buddy)
	 */
	function renderDotsCluster(box, cluster, videoId, records) {
		// Most-recent watcher first — the same order watchedByLabel names them.
		const watchers = records.slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.clientId < b.clientId ? -1 : 1));

		if (!cluster) {
			// The thumbnail box must establish a positioning context; only mutate
			// YouTube's layout when it doesn't already (`yt-thumbnail-view-model`
			// ships `position: relative`, classic `a#thumbnail` does not).
			if (getComputedStyle(box).position === 'static') {
				box.style.position = 'relative';
			}
			cluster = document.createElement('div');
			cluster.className = THUMB_DOTS_CLASS;
			cluster.setAttribute('role', 'img');
			cluster.tabIndex = 0; // keyboard focus shows the tooltip
			const tooltip = document.createElement('div');
			tooltip.className = TOOLTIP_CLASS;
			cluster.appendChild(tooltip);
			box.appendChild(cluster);
		}

		// Label first (cheap, and names can change without the watcher set
		// changing): the Buddies-only variant — never a "You" entry.
		const label = 'Watched by ' + YTB.watchedByLabel(watchers, videoId, myClientId, roster, { buddiesOnly: true });
		cluster.setAttribute('aria-label', label);
		cluster.querySelector(':scope > .' + TOOLTIP_CLASS).textContent = label;

		// Rebuild the dots only when the video or its watcher set changed.
		const sig = videoId + '|' + watchers.map((w) => w.clientId).join(',');
		if (cluster.dataset.ytbSig !== sig) {
			for (const dot of cluster.querySelectorAll(':scope > .' + THUMB_DOT_CLASS)) dot.remove();
			const tooltip = cluster.querySelector(':scope > .' + TOOLTIP_CLASS);
			for (const w of watchers) {
				const dot = document.createElement('div');
				dot.className = THUMB_DOT_CLASS;
				dot.dataset.ytbCid = w.clientId;
				cluster.insertBefore(dot, tooltip);
			}
			cluster.dataset.ytbSig = sig;
		}

		// Colors every pass — never behind the signature guard (see above).
		for (const dot of cluster.querySelectorAll(':scope > .' + THUMB_DOT_CLASS)) {
			dot.style.background = YTB.buddyColor(dot.dataset.ytbCid);
		}
	}

	/**
	 * Mirror the Watched-By Dots into YouTube's hover-autoplay inline preview
	 * while it covers a decorated tile, so the dots stay visible AND hoverable
	 * during the preview. Runs on every render pass (the preview mounting
	 * triggers ytb:mutation); a preview that is hidden, previewing an
	 * un-watched video, or gone again loses its mirrored cluster.
	 */
	function renderPreviewDots() {
		for (const host of document.querySelectorAll(PREVIEW_HOST_SELECTOR)) {
			const cluster = host.querySelector('.' + THUMB_DOTS_CLASS);
			const anchor = host.querySelector('a[href*="/watch?v="]');
			const visible = host.getBoundingClientRect().width > 0;
			const videoId = visible && anchor ? videoIdFromHref(anchor.getAttribute('href')) : null;
			const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;
			if (!records || records.length === 0) {
				if (cluster) cluster.remove();
				continue;
			}
			renderDotsCluster(host, cluster, videoId, records);
		}
	}

	// ---------------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------------

	/**
	 * Whether a record can be placed on the bar at all (finite timestamp, positive
	 * finite duration). Where it lands is YTB.timeToX's business (#159).
	 * @param {{timestamp: number, duration: number}} record
	 * @returns {boolean}
	 */
	function hasPosition(record) {
		const t = Number(record.timestamp);
		const d = Number(record.duration);
		return Number.isFinite(t) && Number.isFinite(d) && d > 0;
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
        /* Half the marker's width, so the 3px bar straddles its timestamp's x
           instead of sitting half a pixel right of it (#159). */
        margin-left: -1.5px;
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
      .${MARKER_CLASS}:hover .${TOOLTIP_CLASS} {
        opacity: 1;
      }
      /* Watched-By Dots: a top-left cluster of flat Buddy-colored dots inside
         the thumbnail box. The negative margin keeps the dots' visual inset at
         ${DOTS_INSET}px while the padding grows the hover/focus target beyond
         the tiny dots. High z-index so the cluster rides above tile overlays
         and an in-box inline preview player. */
      .${THUMB_DOTS_CLASS} {
        position: absolute;
        top: ${DOTS_INSET}px;
        left: ${DOTS_INSET}px;
        display: flex;
        align-items: center;
        gap: ${DOT_GAP}px;
        /* 8px padding (cancelled by the margin, so the dots keep their
           ${DOTS_INSET}px visual inset) grows the focus/hover target to the
           24px minimum even for a single dot (UA-012). */
        padding: 8px;
        margin: -8px;
        border-radius: 999px;
        z-index: 600;
        pointer-events: auto;
        cursor: default;
      }
      /* Two-tone focus ring (UA-013): the dark inner layer keeps the
         indicator visible over bright thumbnails, the white outline over
         dark ones. */
      .${THUMB_DOTS_CLASS}:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.9);
        outline-offset: 1px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
      }
      .${THUMB_DOT_CLASS} {
        width: ${DOT_SIZE}px;
        height: ${DOT_SIZE}px;
        border-radius: 50%;
        background: ${fallback};
      }
      /* The cluster's single dark tooltip opens below the dots, left-aligned
         (the box clips at overflow: hidden, so it must open inward), wrapping
         instead of clipping when the name list runs long. */
      .${THUMB_DOTS_CLASS} > .${TOOLTIP_CLASS} {
        top: 100%;
        bottom: auto;
        left: 8px;
        transform: none;
        white-space: normal;
        width: max-content;
        max-width: 220px;
      }
      .${THUMB_DOTS_CLASS}:hover > .${TOOLTIP_CLASS},
      .${THUMB_DOTS_CLASS}:focus-visible > .${TOOLTIP_CLASS} {
        opacity: 1;
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

	// The markers sit at bar px (#159), so a bar that changes width must re-place
	// them. The thumbnail dots carry no bar geometry and are left alone.
	for (const type of ['resize', 'fullscreenchange']) {
		window.addEventListener(type, () => {
			if (!YTB.isContextActive()) return;
			renderWatchMarker(currentVideoId);
		});
	}

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.buddyProgressHidden) return;
		// Live Buddy Progress Visibility flip from the popup Settings.
		buddyProgressHidden = changes.buddyProgressHidden.newValue === true;
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	// A Buddy Color re-assignment. shared.js owns the one buddyColors storage
	// listener and has already refreshed the cache when this rebroadcast fires
	// (issue #115); repaint the markers and thumbnail bars from cached records.
	document.addEventListener('ytb:buddy-colors', () => {
		if (!YTB.isContextActive()) return;
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
