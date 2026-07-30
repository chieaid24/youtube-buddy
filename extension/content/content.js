// extension/content.js
// The ONLY navigation/DOM-churn observer (Contract C); reporter.js and renderer.js are pure consumers, never detecting navigation themselves.
// Loaded LAST so their ytb:* listeners exist before the initial ytb:navigate fires. Emits on document: ytb:navigate {url, videoId} (load + each SPA nav),
// ytb:mutation (throttled <=1/500ms on DOM churn), ytb:yt-theme {dark} (on each YouTube <html dark> flip, ADR-0009; theme.js restamps).

(function () {
	'use strict';

	const MUTATION_THROTTLE_MS = 500;
	const URL_POLL_MS = 1000;

	// The v= param on a /watch page, else null.
	function videoIdFromUrl(url) {
		try {
			const u = new URL(url, location.href);
			return u.pathname === '/watch' ? u.searchParams.get('v') : null;
		} catch {
			return null;
		}
	}

	let lastUrl = location.href;

	function emitNavigate() {
		const url = location.href;
		lastUrl = url;
		document.dispatchEvent(
			new CustomEvent('ytb:navigate', {
				detail: { url, videoId: videoIdFromUrl(url) },
			}),
		);
	}

	// Fire a navigate event only when the URL actually changed (so fallback detectors don't double-fire alongside yt-navigate-finish).
	function emitNavigateIfUrlChanged() {
		if (location.href !== lastUrl) emitNavigate();
	}

	// --- throttled ytb:mutation ---
	let trailingTimer = null;
	let lastMutationEmit = 0;
	let urlPollTimer = null;

	function emitMutation() {
		lastMutationEmit = Date.now();
		document.dispatchEvent(new CustomEvent('ytb:mutation'));
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
	document.addEventListener('yt-navigate-finish', emitNavigate);

	// Fallback + mutation source: watches the body subtree, re-checking the URL each mutation (catches navs yt-navigate-finish misses) and feeding
	// throttled ytb:mutation for feed lazy-loads. A batch that's entirely our own churn (#174) emits nothing, so our own UI can't re-trigger itself.
	const observer = new MutationObserver((records) => {
		emitNavigateIfUrlChanged();
		if (!YTB.ytbOwnedChurn(records)) emitMutationThrottled();
	});
	observer.observe(document.body, { childList: true, subtree: true });

	// Last-resort nav fallback: a cheap URL poll for transitions the observer somehow misses.
	urlPollTimer = setInterval(emitNavigateIfUrlChanged, URL_POLL_MS);

	// --- YouTube theme tracking (ADR-0009) ---
	// YouTube toggles <html dark> for its theme; watch it so Auto Theme Preference can follow live (theme.js restamps; ADR-0001 keeps DOM
	// observation here, not in theme.js). Only real flips emit.
	let lastDark = document.documentElement.hasAttribute('dark');
	function emitYtThemeIfChanged() {
		const dark = document.documentElement.hasAttribute('dark');
		if (dark === lastDark) return;
		lastDark = dark;
		document.dispatchEvent(new CustomEvent('ytb:yt-theme', { detail: { dark } }));
	}
	const themeObserver = new MutationObserver(emitYtThemeIfChanged);
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['dark'],
	});

	YTB.onContextInvalidated(() => {
		document.removeEventListener('yt-navigate-finish', emitNavigate);
		observer.disconnect();
		themeObserver.disconnect();
		if (trailingTimer !== null) clearTimeout(trailingTimer);
		if (urlPollTimer !== null) clearInterval(urlPollTimer);
		trailingTimer = null;
		urlPollTimer = null;
	});

	// Initial navigate, synchronous on load; reporter/renderer registered their listeners earlier in the `js` array, so they receive this.
	emitNavigate();
})();
