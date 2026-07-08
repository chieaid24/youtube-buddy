// extension/home-toggle.js
//
// The Room Home Toggle: an icon + "Buddy Room" row injected into YouTube's
// own left guide (sidebar) on the home route, controlling whether the Room
// Home Section (home-section.js) renders at all. There is no switch — the
// row is styled to be pixel-indistinguishable from the native guide entries
// (Home / Shorts / Subscriptions), and the buddies icon itself is the state
// indicator: apricot while the section is shown, the native guide-icon color
// while hidden. Off removes the section completely; the toggle row itself
// stays in the guide so it can be turned back on. The state persists per
// install in chrome.storage.local (shared.js getHomeSectionHidden/
// setHomeSectionHidden) and only affects the home surface — on-video
// markers, Notes, presence, and the watch-page control are untouched.
//
// Like the kebab injection in playlist-add.js, targeting YouTube's guide DOM
// DELIBERATELY accepts markup fragility, contained to this one module: the
// row is appended to the expanded guide's first section (below Home /
// Subscriptions) and re-attempted on content.js's throttled ytb:mutation
// until the guide is present. Pure consumer per ADR-0001.
//
// Contract with home-section.js: after each persisted flip this module
// dispatches `ytb:home-section-visibility` with detail {hidden}; the section
// module also reads the stored preference itself on load, so neither module
// depends on the other having run.

(function () {
	'use strict';

	const ROW_ID = 'ytb-home-toggle';
	const STYLE_ID = 'ytb-home-toggle-style';
	const SVG_NS = 'http://www.w3.org/2000/svg';
	// A two-person "buddies" glyph (Material "people"). While the section is
	// hidden it inherits the row text color — which is exactly what native
	// guide icons render at in today's markup (rgb(15,15,15) light /
	// rgb(241,241,241) dark, measured on production YouTube) — so it matches
	// Home / Shorts / Subscriptions; while shown it flips to the apricot
	// accent, the row's only ON/OFF signal.
	const PEOPLE_PATH =
		'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z';

	let onHome = false;
	let hidden = null; // null until the stored preference has been read
	let flipping = false; // one persisted flip at a time

	injectStyle();

	YTB.getHomeSectionHidden().then((value) => {
		if (hidden === null) hidden = value;
		ensureRow();
	});

	// A popup-Settings flip of the same homeSectionHidden key must reflect in
	// this guide row live (our own click also lands here — idempotent).
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.homeSectionHidden || !YTB.isContextActive()) return;
		hidden = changes.homeSectionHidden.newValue === true;
		const row = document.getElementById(ROW_ID);
		if (row) syncRow(row);
		else ensureRow();
	});

	function isHomePath() {
		return location.pathname === '/';
	}

	/** The guide slot the row lives in: the expanded guide's first section's
	 * item list, falling back to the section container when YouTube's inner
	 * markup shifts. Null while the guide isn't built yet (retry on mutation). */
	function guideSlot() {
		const guide = document.querySelector('ytd-guide-renderer');
		if (!guide) return null;
		return guide.querySelector('#sections ytd-guide-section-renderer #items') || guide.querySelector('#sections') || guide;
	}

	function ensureRow() {
		if (!YTB.isContextActive()) return;
		// Off the home route (or before the stored state is known) the row has
		// no business in the page; the section module gates itself the same way.
		if (!onHome || hidden === null) {
			document.getElementById(ROW_ID)?.remove();
			return;
		}
		let row = document.getElementById(ROW_ID);
		if (row && row.isConnected) return;

		const slot = guideSlot();
		if (!slot) return; // guide not built yet — a later ytb:mutation retries

		row = document.createElement('button');
		row.id = ROW_ID;
		row.type = 'button';
		row.setAttribute('role', 'switch');
		row.title = 'Show or hide the Buddy Room section on Home';

		const iconWrap = document.createElement('span');
		iconWrap.className = 'ytb-ht-icon';
		iconWrap.append(buildIcon());
		const label = document.createElement('span');
		label.className = 'ytb-ht-label';
		label.textContent = 'Buddy Room';
		row.append(iconWrap, label);

		row.addEventListener('click', async () => {
			if (flipping || hidden === null) return;
			flipping = true;
			hidden = !hidden;
			syncRow(row);
			await YTB.setHomeSectionHidden(hidden);
			flipping = false;
			document.dispatchEvent(new CustomEvent('ytb:home-section-visibility', { detail: { hidden } }));
		});

		syncRow(row);
		slot.appendChild(row);
	}

	/** Reflect the current state: checked means the section is shown, and the
	 * is-on class tints the buddies icon apricot — the row's only signal. */
	function syncRow(row) {
		const shown = hidden === false;
		row.setAttribute('aria-checked', String(shown));
		row.classList.toggle('is-on', shown);
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer, registered synchronously (before content.js fires
	// the initial ytb:navigate).
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', () => {
		if (!YTB.isContextActive()) return;
		onHome = isHomePath();
		ensureRow();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		// YouTube rebuilds the guide lazily; keep the row present without churn.
		ensureRow();
	});

	YTB.onContextInvalidated(() => {
		document.getElementById(ROW_ID)?.remove();
	});

	/** The left buddies glyph as an inline SVG (fill follows currentColor). */
	function buildIcon() {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '24');
		svg.setAttribute('height', '24');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', PEOPLE_PATH);
		path.setAttribute('fill', 'currentColor');
		svg.append(path);
		return svg;
	}

	/** Inject the row stylesheet once (light + html[dark] themes). Every
	 * metric below was measured off a production YouTube guide entry
	 * (Home / Shorts / Subscriptions) so the row is pixel-indistinguishable
	 * from its native siblings; the --yt-spec-* custom properties are gone
	 * from today's markup, so the measured values are written out directly. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${ROW_ID} {
        --ytbht-accent: #f6a96b;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        width: calc(100% - 12px);    /* native entries leave a 12px right inset in #items */
        height: 40px;                /* native guide-entry row height */
        margin: 0;                   /* flush with the sibling guide rows */
        padding: 0 12px;             /* seats the icon 12px in, exactly like native rows */
        border: 0;
        border-radius: 10px;         /* native guide hover radius */
        background: transparent;
        color: #0f0f0f;              /* native guide text color */
        font-family: 'Roboto', 'Arial', sans-serif;
        font-size: 14px;             /* native guide typography: 14px/20px, weight 500 */
        font-weight: 500;
        line-height: 20px;
        text-align: left;
        cursor: pointer;
        -webkit-font-smoothing: antialiased;
      }
      html[dark] #${ROW_ID} { color: #f1f1f1; }
      #${ROW_ID}:hover { background: rgba(0, 0, 0, 0.05); }              /* native hover */
      html[dark] #${ROW_ID}:hover { background: rgba(255, 255, 255, 0.1); }
      #${ROW_ID}:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ytbht-accent); }
      #${ROW_ID} .ytb-ht-icon {
        flex: none;
        display: inline-flex;
        width: 24px; height: 24px;
        margin-right: 24px;          /* native icon-to-label gap: label aligns with siblings */
        color: inherit;              /* OFF: the native guide-icon color (= text color) */
        transition: color 140ms;
      }
      #${ROW_ID}.is-on .ytb-ht-icon { color: var(--ytbht-accent); }   /* ON: apricot */
      #${ROW_ID} .ytb-ht-icon svg { display: block; width: 24px; height: 24px; }
      #${ROW_ID} .ytb-ht-label {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: inherit;
      }
      @media (prefers-reduced-motion: reduce) {
        #${ROW_ID} .ytb-ht-icon { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
