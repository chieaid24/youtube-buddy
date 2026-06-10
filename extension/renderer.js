// extension/renderer.js
//
// The renderer: draws the Buddy's Progress Records — a marker on the active
// video's player progress bar, and fractional bars on thumbnails across the
// home/recommended/search/listing surfaces. Display-only (no click-to-seek).
//
// Loaded as the 3rd content-script file (after shared.js + reporter.js, before
// content.js), so `window.YTB` exists and our `ytb:*` listeners are attached
// synchronously at top level BEFORE content.js (loaded last) fires the initial
// ytb:navigate. Content scripts are NOT ES modules — communicate only via the
// window.YTB global and `document` events (no import/export). See ADR-0001 and
// tasks/06-extension-renderer.md.
//
// We are a pure CONSUMER of navigation/mutation: content.js owns the single
// observer and emits ytb:navigate / ytb:mutation; we never detect either.
//
// "Buddy" filter: a record is the Buddy's iff record.clientId !== myClientId.
// Reads happen regardless of the Sharing toggle — Sharing only gates POSTs.

(function () {
  "use strict";

  // --- constants ---
  // YouTube's own "already watched" bar is red; the Buddy bar must be visibly
  // different so users don't confuse it with their own history. Bright cyan.
  const BUDDY_COLOR = "#1ec8ff";

  const MARKER_CLASS = "ytb-watch-marker";
  const TOOLTIP_CLASS = "ytb-watch-tooltip";
  const THUMB_BAR_CLASS = "ytb-thumb-bar";
  const STYLE_ID = "ytb-renderer-style";

  // --- state ---
  let myClientId = null; // memoized; my own records are filtered out
  let buddyByVideoId = new Map(); // videoId -> most-recent Buddy ProgressRecord
  let currentVideoId = null; // active /watch video, or null off a watch page
  let refreshToken = 0; // guards against out-of-order async refreshes

  injectStyle();

  // ---------------------------------------------------------------------------
  // Data: fetch + cache the Buddy's records.
  // ---------------------------------------------------------------------------

  /**
   * GET every record under the configured Friend Code, keep only the Buddy's
   * (foreign clientId), and index them by videoId (most-recent updatedAt wins).
   * Bails to an empty cache when there is no code (Unpaired — nothing to draw).
   * Server-side TTL already drops records older than 14 days, so no age filter
   * is needed here.
   */
  async function refresh() {
    const { code } = await YTB.getConfig();
    if (!code) {
      buddyByVideoId = new Map();
      return;
    }
    myClientId = myClientId || (await YTB.ensureClientId());
    const all = await YTB.getRecords(code);
    const next = new Map();
    for (const r of all) {
      if (!r || r.clientId === myClientId || !r.videoId) continue;
      const prev = next.get(r.videoId);
      if (!prev || r.updatedAt > prev.updatedAt) next.set(r.videoId, r);
    }
    buddyByVideoId = next;
  }

  // ---------------------------------------------------------------------------
  // Watch page: marker on the player progress bar.
  // ---------------------------------------------------------------------------

  /**
   * Draw (or refresh) the Buddy marker on `.ytp-progress-bar` for `videoId`.
   * No-op when there's no Buddy record for the video or the bar isn't built yet
   * (the player initializes async — ytb:mutation re-invokes us until it is).
   * Idempotent: reuses the single marker element if already present.
   * @param {string|null} videoId
   */
  function renderWatchMarker(videoId) {
    const bar = document.querySelector(".ytp-progress-bar");
    if (!bar) return; // player not ready yet — a later ytb:mutation retries
    const record = videoId ? buddyByVideoId.get(videoId) : null;
    const fraction = record ? positionFraction(record) : null;
    if (fraction === null) {
      removeWatchMarker();
      return;
    }

    let marker = bar.querySelector(":scope > ." + MARKER_CLASS);
    if (!marker) {
      // The bar must establish a positioning context for the absolute marker.
      if (getComputedStyle(bar).position === "static") {
        bar.style.position = "relative";
      }
      marker = document.createElement("div");
      marker.className = MARKER_CLASS;
      const tooltip = document.createElement("div");
      tooltip.className = TOOLTIP_CLASS;
      marker.appendChild(tooltip);
      bar.appendChild(marker);
    }
    marker.style.left = (fraction * 100).toFixed(3) + "%";
    const who = record.name ? record.name : "Buddy";
    marker.querySelector("." + TOOLTIP_CLASS).textContent =
      who + " · " + YTB.formatTime(record.timestamp);
  }

  /** Remove any Buddy marker(s) (e.g. on leaving a watch page). */
  function removeWatchMarker() {
    document.querySelectorAll("." + MARKER_CLASS).forEach((n) => n.remove());
  }

  // ---------------------------------------------------------------------------
  // Thumbnails: fractional bottom bar on every matching tile.
  // ---------------------------------------------------------------------------

  /**
   * Overlay a fractional bar on every thumbnail tile whose video matches a
   * Buddy record. Idempotent + recycle-safe: YouTube reuses tile DOM nodes for
   * different videos as you scroll, so each pass re-keys the bar to the tile's
   * CURRENT videoId and drops a stale bar when the tile no longer matches.
   */
  function renderThumbnails() {
    const anchors = document.querySelectorAll('a[href*="/watch?v="]');
    for (const anchor of anchors) {
      // Decorate only thumbnail anchors — the ones wrapping the tile image — so
      // we never draw a bar across a video-title link. The image check is
      // surface-agnostic: it matches both the classic `a#thumbnail` tiles and
      // the newer `yt-lockup-view-model` tiles, whose anchors differ.
      if (!anchor.querySelector("img")) continue;

      const videoId = videoIdFromHref(anchor.getAttribute("href"));
      const record = videoId ? buddyByVideoId.get(videoId) : null;
      const fraction = record ? positionFraction(record) : null;
      const existing = anchor.querySelector(":scope > ." + THUMB_BAR_CLASS);

      if (fraction === null) {
        if (existing) existing.remove();
        delete anchor.dataset.ytbVid;
        continue;
      }

      let bar = existing;
      if (!bar) {
        // The anchor must establish a positioning context for the absolute bar.
        if (getComputedStyle(anchor).position === "static") {
          anchor.style.position = "relative";
        }
        bar = document.createElement("div");
        bar.className = THUMB_BAR_CLASS;
        anchor.appendChild(bar);
      }
      bar.style.width = (fraction * 100).toFixed(3) + "%";
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
      return u.pathname === "/watch" ? u.searchParams.get("v") : null;
    } catch {
      return null;
    }
  }

  /** Inject the renderer's CSS once (no separate stylesheet file). */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${MARKER_CLASS} {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 3px;
        margin-left: -1px;
        background: ${BUDDY_COLOR};
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
      }
      .${MARKER_CLASS}:hover .${TOOLTIP_CLASS} {
        opacity: 1;
      }
      .${THUMB_BAR_CLASS} {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 4px;
        max-width: 100%;
        background: ${BUDDY_COLOR};
        pointer-events: none;
        z-index: 2000;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Wiring: pure consumer of content.js's ytb:* events. Registered
  // synchronously so the initial ytb:navigate (fired by content.js, loaded
  // last) is received.
  // ---------------------------------------------------------------------------

  document.addEventListener("ytb:navigate", async (e) => {
    currentVideoId = (e.detail && e.detail.videoId) || null;
    const token = ++refreshToken;
    await refresh();
    if (token !== refreshToken) return; // a newer navigate superseded this one
    renderWatchMarker(currentVideoId);
    renderThumbnails();
  });

  document.addEventListener("ytb:mutation", () => {
    // The feed lazy-loaded more tiles (and/or the player finished building).
    // Use the cached records — no re-GET. Re-apply the marker too, since the
    // progress bar may have only just appeared after the last navigate.
    renderWatchMarker(currentVideoId);
    renderThumbnails();
  });
})();
