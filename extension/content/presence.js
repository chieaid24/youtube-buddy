// Presence asserter: announces "I'm here" under the active Room Code, independent of watching/Sharing.
// Loaded after shared.js, before content.js; a pure consumer of its ytb:navigate events (ADR-0001).

(() => {
	'use strict';

	const ASSERT_INTERVAL_MS = 5 * 60_000; // throttle: at most once per ~5 min/tab

	let lastAssert = 0;

	// Reasserts if the throttle has elapsed; independent of Sharing, not gated to /watch.
	async function maybeAssert() {
		if (!YTB.isContextActive()) return;
		if (Date.now() - lastAssert < ASSERT_INTERVAL_MS) return;
		const { code } = await YTB.getConfig();
		if (!code) return; // Unpaired - nobody to appear to.
		lastAssert = Date.now();
		YTB.assertPresence(code);
	}

	// Every navigation is a chance to reassert; the throttle caps actual sends.
	document.addEventListener('ytb:navigate', maybeAssert);
	YTB.onContextInvalidated(() => document.removeEventListener('ytb:navigate', maybeAssert));
})();
