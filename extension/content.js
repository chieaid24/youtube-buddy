// extension/content.js
//
// The bootstrap. This is the ONLY place that detects YouTube navigation and DOM
// churn; the reporter (task 05) and renderer (task 06) are pure consumers of the
// events dispatched here — they never detect navigation themselves.
//
// Loaded LAST in the content-script `js` array, so shared.js (YTB) exists and
// the reporter/renderer have already attached their `ytb:*` listeners
// synchronously at top level. That lets us dispatch the initial `ytb:navigate`
// synchronously on load (see the bottom of this file).
//
// Events emitted on `document` (Contract C):
//   - ytb:navigate { url, videoId }  — once on load + on every SPA navigation.
//   - ytb:mutation                   — throttled (<= once / 500ms) on DOM churn.

(function () {
  "use strict";

  const MUTATION_THROTTLE_MS = 500;
  const URL_POLL_MS = 1000;

  /** @returns {string|null} the `v=` param on a /watch page, else null. */
  function videoIdFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname === "/watch" ? u.searchParams.get("v") : null;
    } catch {
      return null;
    }
  }

  let lastUrl = location.href;

  function emitNavigate() {
    const url = location.href;
    lastUrl = url;
    document.dispatchEvent(
      new CustomEvent("ytb:navigate", {
        detail: { url, videoId: videoIdFromUrl(url) },
      }),
    );
  }

  // Fire a navigate event only when the URL actually changed (used by the
  // fallback detectors so they don't double-fire alongside yt-navigate-finish).
  function emitNavigateIfUrlChanged() {
    if (location.href !== lastUrl) emitNavigate();
  }

  // --- throttled ytb:mutation ---
  let trailingTimer = null;
  let lastMutationEmit = 0;
  let urlPollTimer = null;

  function emitMutation() {
    lastMutationEmit = Date.now();
    document.dispatchEvent(new CustomEvent("ytb:mutation"));
  }

  function emitMutationThrottled() {
    const elapsed = Date.now() - lastMutationEmit;
    if (elapsed >= MUTATION_THROTTLE_MS) {
      emitMutation();
    } else if (trailingTimer === null) {
      // Schedule a trailing emit so the final burst of mutations isn't dropped.
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        emitMutation();
      }, MUTATION_THROTTLE_MS - elapsed);
    }
  }

  // --- navigation detection ---
  // Primary: YouTube's Polymer app fires `yt-navigate-finish` on SPA nav.
  document.addEventListener("yt-navigate-finish", emitNavigate);

  // Fallback + mutation source: watch the body subtree. Each mutation cheaply
  // re-checks the URL (catches navs that don't surface yt-navigate-finish) and
  // feeds the throttled ytb:mutation used for feed lazy-loads.
  const observer = new MutationObserver(() => {
    emitNavigateIfUrlChanged();
    emitMutationThrottled();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Last-resort nav fallback: a cheap URL poll for transitions the observer
  // somehow misses.
  urlPollTimer = setInterval(emitNavigateIfUrlChanged, URL_POLL_MS);

  YTB.onContextInvalidated(() => {
    document.removeEventListener("yt-navigate-finish", emitNavigate);
    observer.disconnect();
    if (trailingTimer !== null) clearTimeout(trailingTimer);
    if (urlPollTimer !== null) clearInterval(urlPollTimer);
    trailingTimer = null;
    urlPollTimer = null;
  });

  // Initial navigate — synchronous on load. The reporter/renderer registered
  // their listeners earlier in the `js` array, so they receive this.
  emitNavigate();
})();
