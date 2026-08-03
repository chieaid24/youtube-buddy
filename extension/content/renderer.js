// extension/renderer.js
// Buddy markers on the player bar + thumbnail Watched-By Dots (display-only; no Note UI).
// The Room's single poller: rebroadcasts each read as ytb:room-data for the other modules.
// Loaded 3rd so ytb:* listeners attach before the first ytb:navigate (ADR-0001); reads run regardless of Sharing.

(function () {
	'use strict';

	// --- constants ---

	const MARKER_CLASS = 'ytb-watch-marker';
	const TOOLTIP_CLASS = 'ytb-watch-tooltip';
	const THUMB_DOTS_CLASS = 'ytb-thumb-dots'; // Watched-By Dots cluster on a thumbnail
	const THUMB_DOT_CLASS = 'ytb-thumb-dot'; // one flat Buddy-colored dot
	// The cluster's tooltip is one row per dot (#176): swatch + Display Name + Watch Status.
	const TOOLTIP_ROW_CLASS = 'ytb-thumb-row';
	const TOOLTIP_SWATCH_CLASS = 'ytb-thumb-swatch';
	const TOOLTIP_NAME_CLASS = 'ytb-thumb-name';
	const TOOLTIP_STATUS_CLASS = 'ytb-thumb-status';
	const STYLE_ID = 'ytb-renderer-style';
	const PRESENCE_POLL_MS = 60_000; // re-GET cadence for live markers + presence

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

	// Buddy Progress Visibility: hidden draws nothing, but polling/rebroadcasting continues.
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
	 * GET the Room's records into the cache. Empties when Unpaired or locked out;
	 * a FAILED read keeps the previous cache (Connection Lost) but still broadcasts.
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
			// A failed read isn't truth: keep the previous cache/roster/baseline (Connection Lost, #137); still broadcast.
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

		notePresence(view.buddies);

		// Locked out of a full Room.
		if (view.locked) {
			buddyByVideoId = new Map();
			broadcastRoomData(null, true);
			return;
		}

		// Rows without a videoId (presence) never produce a marker.
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

	// Single-poller hand-off to the other modules (none of them poll).
	// `records` is null for an empty broadcast (no code, or locked out).
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
					// False on a failed GET — never truth; notes.js prunes Unseen state only when ok (ADR-0010).
					ok: Boolean(r.ok),
					// >= 2 consecutive failed reads (YTB.connectionState); on every broadcast so consumers need no counter.
					connectionLost,
				},
			}),
		);
	}

	// Unpaired reset, so rejoining doesn't replay every member as a fresh "joined".
	function resetPresenceBaseline() {
		knownBuddyIds = new Set();
		baselineReady = false;
	}

	// Toast clientIds new since the last read; the first read only seeds the baseline.
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
	 * Draw/refresh one marker per Buddy on `.ytp-progress-bar` for `videoId`, in
	 * that Buddy's color, with a hover tooltip. No-op until the bar exists
	 * (ytb:mutation retries). Keyed by clientId so markers survive re-renders
	 * without flicker; left Buddies are removed. Overlaps are allowed.
	 * @param {string|null} videoId
	 */
	function renderWatchMarker(videoId) {
		const bar = document.querySelector('.ytp-progress-bar');
		if (!bar) return; // player not ready yet — a later ytb:mutation retries

		// Hidden Buddy Progress leaves `desired` empty, so reconciliation below
		// strips markers (and regrows them when re-shown).
		const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;
		const desired = new Map(); // clientId -> record
		if (records) {
			for (const r of records) {
				if (hasPosition(r)) desired.set(r.clientId, r);
			}
		}

		// Reconcile by clientId (keep wanted, drop the rest); indexed rather than
		// queried per id so no clientId can form a bad attribute selector.
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

		// Placed via YouTube's chapter geometry (#159), re-measured here so a
		// resize, theater/fullscreen, or late chapter DOM re-aligns markers next render.
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
	// Thumbnails: Watched-By Dots — a top-left cluster of flat dots, one per
	// Buddy with a Progress Record for that video, newest first, viewer excluded
	// (YouTube's own Watched Bar covers that). Hover/focus shows a "Watched by
	// <names>" tooltip. YouTube-thumbnail-DOM fragility is deliberately
	// contained here (as playlist-add.js/home-toggle.js do for the menu/guide).
	// ---------------------------------------------------------------------------

	// YouTube's hover-autoplay preview host: a document-level singleton, larger
	// than the tile it covers. While it covers a decorated tile, the cluster is
	// mirrored into the host, which owns it (#174) — the tile's own is swept,
	// never left to stacking-order luck.
	const PREVIEW_HOST_SELECTOR = 'ytd-video-preview';

	/**
	 * The tile's real thumbnail box the dots must never escape. Lockup tiles'
	 * (`yt-lockup-view-model`) anchor is wider/taller than the image, so this
	 * anchors to the nested `yt-thumbnail-view-model` instead; classic
	 * `a#thumbnail` tiles ARE their image box, so the anchor itself stands.
	 * @param {Element} anchor
	 * @returns {Element}
	 */
	function thumbBoxFor(anchor) {
		return anchor.querySelector('yt-thumbnail-view-model') || anchor;
	}

	/**
	 * Overlay Watched-By Dots on every tile whose video has a Buddy record.
	 * Idempotent + recycle-safe: re-keys each cluster to the tile's current
	 * videoId and only rebuilds dots when the video/watcher set changes (a
	 * signature guard), so frequent ytb:mutation passes never tear down a
	 * tooltip mid-hover; colors repaint every pass regardless. Exactly one
	 * surface owns a video's cluster (#174): a preview mirror wins over its
	 * covered tile; the closing sweep removes every unclaimed cluster, so
	 * doubling is impossible by construction.
	 */
	function renderThumbnails() {
		const claimed = new Set(); // every cluster this pass kept
		// Preview pass runs first, deciding which tile boxes a visible preview
		// covers so the tile pass below can cede those clusters.
		const coveredBoxes = renderPreviewDots(claimed);

		const anchors = document.querySelectorAll('a[href*="/watch?v="]');
		for (const anchor of anchors) {
			// Only thumbnail-image anchors (never a title link); the img check
			// matches both classic and lockup tile anchors.
			if (!anchor.querySelector('img')) continue;

			// Our Recommended-for-you cards keep their own text label; dots there
			// would double it.
			if (anchor.closest('#ytb-home-section')) continue;

			// Preview-host anchors belong to renderPreviewDots — decorating both
			// would double the dots.
			if (anchor.closest(PREVIEW_HOST_SELECTOR)) continue;

			const videoId = videoIdFromHref(anchor.getAttribute('href'));
			// Hidden Buddy Progress nulls records here, so unclaimed dots are swept.
			const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;
			if (!records || records.length === 0) continue;

			const box = thumbBoxFor(anchor);
			// A visible preview covers this tile — the mirror owns the cluster;
			// ours goes unclaimed and is swept.
			if (coveredBoxes.has(box)) continue;

			// Anchor-scoped lookup finds the cluster wherever the box resolved to;
			// one attached before hydration is rebuilt in the right parent (the
			// stray is swept).
			let cluster = anchor.querySelector('.' + THUMB_DOTS_CLASS);
			if (cluster && !box.contains(cluster)) cluster = null;

			claimed.add(renderDotsCluster(box, cluster, videoId, records));
		}

		// Sweep: any unclaimed cluster (recycled tile, stale mirror, ceded tile)
		// is an orphan and goes — at most one per video survives.
		for (const cluster of document.querySelectorAll('.' + THUMB_DOTS_CLASS)) {
			if (!claimed.has(cluster)) cluster.remove();
		}
	}

	/**
	 * Build/reconcile one Watched-By Dots cluster inside `box`: one dot per
	 * Buddy record (newest first) plus a tooltip row each (swatch + name +
	 * status, #176). Shared by the per-tile pass and the preview mirror;
	 * reconciles in place so an unchanged pass never tears down a tooltip
	 * mid-hover (#174).
	 * @param {Element} box positioning parent the cluster must stay inside
	 * @param {?Element} cluster existing cluster in `box`, if any
	 * @param {string} videoId
	 * @param {Array<object>} records this video's Buddy records (latest per Buddy)
	 * @returns {Element} the cluster kept by this pass
	 */
	function renderDotsCluster(box, cluster, videoId, records) {
		// One row per Buddy (viewer excluded, newest first) in the same order the
		// dots render, so dots and rows never drift; row i pairs dot i.
		const rows = YTB.watchedByRows(records, videoId, myClientId, roster);

		if (!cluster) {
			// Only set position:relative when YouTube's own layout doesn't already
			// (yt-thumbnail-view-model does, classic a#thumbnail doesn't).
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

		// aria-label mirrors the visual rows so screen readers get what the
		// pointer shows; guarded so an unchanged pass writes nothing.
		const label = YTB.watchedByAriaLabel(rows);
		if (cluster.getAttribute('aria-label') !== label) cluster.setAttribute('aria-label', label);
		const tooltip = cluster.querySelector(':scope > .' + TOOLTIP_CLASS);

		// Rebuild dots + tooltip rows only when the video/ordered watcher set
		// changes (signature guard, keeps them aligned); colors/status reconcile
		// every pass below regardless.
		const sig = videoId + '|' + rows.map((r) => r.clientId).join(',');
		if (cluster.dataset.ytbSig !== sig) {
			for (const dot of cluster.querySelectorAll(':scope > .' + THUMB_DOT_CLASS)) dot.remove();
			tooltip.replaceChildren();
			for (const row of rows) {
				const dot = document.createElement('div');
				dot.className = THUMB_DOT_CLASS;
				dot.dataset.ytbCid = row.clientId;
				cluster.insertBefore(dot, tooltip);

				const rowEl = document.createElement('div');
				rowEl.className = TOOLTIP_ROW_CLASS;
				const swatch = document.createElement('span');
				swatch.className = TOOLTIP_SWATCH_CLASS;
				const name = document.createElement('span');
				name.className = TOOLTIP_NAME_CLASS;
				const status = document.createElement('span');
				status.className = TOOLTIP_STATUS_CLASS;
				rowEl.append(swatch, name, status);
				tooltip.appendChild(rowEl);
			}
			cluster.dataset.ytbSig = sig;
		}

		// Reconcile color/text every pass (a color pick, rename, or advance can
		// change these without changing the set); colors set unconditionally,
		// text guarded. Dot i pairs row i.
		const dotEls = cluster.querySelectorAll(':scope > .' + THUMB_DOT_CLASS);
		const rowEls = tooltip.querySelectorAll(':scope > .' + TOOLTIP_ROW_CLASS);
		rows.forEach((row, i) => {
			const color = YTB.buddyColor(row.clientId);
			dotEls[i].style.background = color;
			const rowEl = rowEls[i];
			rowEl.querySelector(':scope > .' + TOOLTIP_SWATCH_CLASS).style.background = color;
			const nameEl = rowEl.querySelector(':scope > .' + TOOLTIP_NAME_CLASS);
			if (nameEl.textContent !== row.name) nameEl.textContent = row.name;
			const statusEl = rowEl.querySelector(':scope > .' + TOOLTIP_STATUS_CLASS);
			const statusText = row.status || '';
			if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
		});

		return cluster;
	}

	/**
	 * Mirror the Watched-By Dots into YouTube's hover-autoplay preview while it
	 * covers a decorated tile, so they stay visible and hoverable — the mirror
	 * stays a descendant of the host, since a document-level float would fire a
	 * synthetic mouseleave and cancel the autoplay. A hidden/un-watched/gone
	 * preview leaves its mirror unclaimed for the sweep.
	 *
	 * The one covered tile (same videoId, geometrically overlapping via
	 * YTB.previewOwnsTile) cedes its own cluster (#174); a duplicate videoId
	 * elsewhere keeps its own dots.
	 * @param {Set<Element>} claimed this pass's claim set (mirrors added here)
	 * @returns {Set<Element>} the tile thumbnail boxes covered by a preview
	 */
	function renderPreviewDots(claimed) {
		const coveredBoxes = new Set();
		for (const host of document.querySelectorAll(PREVIEW_HOST_SELECTOR)) {
			const cluster = host.querySelector('.' + THUMB_DOTS_CLASS);
			const hostRect = host.getBoundingClientRect();
			const anchor = hostRect.width > 0 ? host.querySelector('a[href*="/watch?v="]') : null;
			const videoId = anchor ? videoIdFromHref(anchor.getAttribute('href')) : null;
			const records = videoId && !buddyProgressHidden ? buddyByVideoId.get(videoId) : null;
			if (!records || records.length === 0) continue;

			claimed.add(renderDotsCluster(host, cluster, videoId, records));

			for (const tileAnchor of document.querySelectorAll('a[href*="/watch?v="]')) {
				if (!tileAnchor.querySelector('img')) continue;
				if (tileAnchor.closest(PREVIEW_HOST_SELECTOR) || tileAnchor.closest('#ytb-home-section')) continue;
				if (videoIdFromHref(tileAnchor.getAttribute('href')) !== videoId) continue;
				const box = thumbBoxFor(tileAnchor);
				if (YTB.previewOwnsTile(hostRect, box.getBoundingClientRect())) coveredBoxes.add(box);
			}
		}
		return coveredBoxes;
	}

	// ---------------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------------

	/**
	 * Whether a record has a placeable position (finite timestamp, positive
	 * finite duration); where it lands is YTB.timeToX's business (#159).
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
        /* Half the marker's width, so the 3px bar straddles its timestamp x (#159). */
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
      /* Watched-By Dots cluster: negative margin keeps the ${DOTS_INSET}px
         visual inset while padding grows the hit target; high z-index rides
         above tile overlays and the inline preview. */
      .${THUMB_DOTS_CLASS} {
        position: absolute;
        top: ${DOTS_INSET}px;
        left: ${DOTS_INSET}px;
        display: flex;
        align-items: center;
        gap: ${DOT_GAP}px;
        /* 8px padding (cancelled by the margin) grows the hit target to the
           24px minimum even for one dot (UA-012). */
        padding: 8px;
        margin: -8px;
        border-radius: 999px;
        z-index: 600;
        pointer-events: auto;
        cursor: default;
      }
      /* Two-tone focus ring (UA-013): dark inner layer visible on bright
         thumbnails, white outline on dark ones. */
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
        /* Hover/focus scales dots ~1.25x (DESIGN.md 2: transform/opacity
           only); the 24px hit target is untouched since transform never reflows. */
        transform-origin: center;
        transition:
          transform var(--ytb-dur-quick, 140ms) var(--ytb-ease-spring, cubic-bezier(0.34, 1.3, 0.64, 1)),
          opacity var(--ytb-dur-quick, 140ms) var(--ytb-ease-out, cubic-bezier(0.22, 1, 0.36, 1));
      }
      .${THUMB_DOTS_CLASS}:hover > .${THUMB_DOT_CLASS},
      .${THUMB_DOTS_CLASS}:focus-visible > .${THUMB_DOT_CLASS} {
        transform: scale(1.25);
      }
      /* Reduced motion: no scale; dots rest dimmed so hover/focus can lift via opacity. */
      @media (prefers-reduced-motion: reduce) {
        .${THUMB_DOT_CLASS} {
          opacity: 0.82;
          transition: opacity var(--ytb-dur-quick, 140ms) var(--ytb-ease-out, cubic-bezier(0.22, 1, 0.36, 1));
        }
        .${THUMB_DOTS_CLASS}:hover > .${THUMB_DOT_CLASS},
        .${THUMB_DOTS_CLASS}:focus-visible > .${THUMB_DOT_CLASS} {
          transform: none;
          opacity: 1;
        }
      }
      /* Tooltip opens below the dots, left-aligned (box clips overflow:
         hidden, so it opens inward); one row per dot: swatch, wrapping name,
         status pinned right. */
      .${THUMB_DOTS_CLASS} > .${TOOLTIP_CLASS} {
        top: 100%;
        bottom: auto;
        left: 8px;
        transform: none;
        white-space: normal;
        width: max-content;
        max-width: 220px;
        padding: 5px 8px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        text-align: left;
      }
      .${TOOLTIP_ROW_CLASS} {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .${TOOLTIP_SWATCH_CLASS} {
        flex: 0 0 auto;
        width: ${DOT_SIZE}px;
        height: ${DOT_SIZE}px;
        border-radius: 50%;
        background: ${fallback};
      }
      .${TOOLTIP_NAME_CLASS} {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .${TOOLTIP_STATUS_CLASS} {
        flex: 0 0 auto;
        margin-left: 12px;
        color: rgba(255, 255, 255, 0.72);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      /* A record with no Watch Status shows the name alone; drop the gutter. */
      .${TOOLTIP_STATUS_CLASS}:empty {
        margin-left: 0;
      }
      .${THUMB_DOTS_CLASS}:hover > .${TOOLTIP_CLASS},
      .${THUMB_DOTS_CLASS}:focus-visible > .${TOOLTIP_CLASS} {
        opacity: 1;
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer of content.js's ytb:* events, registered
	// synchronously so the first ytb:navigate (fired last) is received.
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
		// Feed lazy-loaded more tiles or the player finished building; use cached
		// records (no re-GET), but re-apply markers in case the bar just appeared.
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	// Markers sit at bar px (#159), so a width change must re-place them;
	// thumbnail dots carry no bar geometry and are left alone.
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

	// Buddy Color re-assignment; shared.js's listener already refreshed the
	// cache by the time this fires (#115) — just repaint from cached records.
	document.addEventListener('ytb:buddy-colors', () => {
		if (!YTB.isContextActive()) return;
		renderWatchMarker(currentVideoId);
		renderThumbnails();
	});

	// Poll every ~60s so a Buddy joining/moving shows up without a navigation
	// (~1 GET/min/tab); refreshToken guard stops a poll from clobbering a fresher
	// navigate render.
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
