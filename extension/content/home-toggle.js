// extension/home-toggle.js
//
// The Room Home Toggle: a "Buddy Room" row injected into YouTube's left
// guide on the home route, pixel-matched to native entries. It OPENS the
// floating Room Home Panel (ADR-0005); open state is ephemeral, owned by
// home-section.js and mirrored here via ytb:home-panel-state CustomEvents
// (no storage). Guide-DOM targeting is deliberately fragile, contained to
// this module (ADR-0001 pure consumer): retried on content.js's throttled
// ytb:mutation until the guide exists.

(function () {
	'use strict';

	const ROW_ID = 'ytb-home-toggle';
	const STYLE_ID = 'ytb-home-toggle-style';
	const SVG_NS = 'http://www.w3.org/2000/svg';
	// A two-person "buddies" glyph (Material "people"): hidden, it inherits the
	// row text color (measured off native guide icons, rgb(15,15,15) light /
	// rgb(241,241,241) dark) to match Home/Shorts/Subscriptions; shown, it
	// flips to the apricot accent - the row's only ON/OFF signal.
	const PEOPLE_PATH =
		'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z';

	let onHome = false;
	let panelOpen = false; // mirrors home-section.js's ephemeral open state

	injectStyle();
	ensureRow();

	// home-section.js owns the panel's open state and broadcasts every change;
	// the row's ON/OFF simply mirrors "panel open" (our own request lands here too).
	document.addEventListener('ytb:home-panel-state', (event) => {
		if (!YTB.isContextActive()) return;
		panelOpen = Boolean(event.detail && event.detail.open);
		const row = document.getElementById(ROW_ID);
		if (row) syncRow(row);
	});

	function isHomePath() {
		return location.pathname === '/';
	}

	/** The guide slot the row lives in, with fallbacks for shifted markup; null
	 * while the guide isn't built yet (retried on mutation). */
	function guideSlot() {
		const guide = document.querySelector('ytd-guide-renderer');
		if (guide) return guide.querySelector('#sections ytd-guide-section-renderer #items') || guide.querySelector('#sections') || guide;
		const miniGuide = document.querySelector('ytd-mini-guide-renderer');
		return miniGuide && (miniGuide.querySelector('#items') || miniGuide);
	}

	function ensureRow() {
		if (!YTB.isContextActive()) return;
		// Off the home route the row has no business here; the panel module gates
		// itself the same way.
		if (!onHome) {
			removeHomeControls();
			return;
		}
		const slot = guideSlot();
		if (!slot) return; // guide not built yet - a later ytb:mutation retries
		let row = document.getElementById(ROW_ID);
		if (row && row.isConnected) {
			if (row.parentElement !== slot) slot.append(row);
			return;
		}

		row = document.createElement('button');
		row.id = ROW_ID;
		row.type = 'button';
		row.setAttribute('role', 'switch');
		row.title = 'Open or close the Buddy Room panel';

		const iconWrap = document.createElement('span');
		iconWrap.className = 'ytb-ht-icon';
		iconWrap.append(buildIcon());
		const label = document.createElement('span');
		label.className = 'ytb-ht-label';
		label.textContent = 'Buddy Room';

		row.append(iconWrap, label);

		row.addEventListener('click', () => {
			// home-section.js owns the state: request a toggle, then mirror the
			// state it broadcasts back (synchronous, same tick).
			document.dispatchEvent(new CustomEvent('ytb:home-panel-request-toggle'));
		});

		syncRow(row);
		slot.append(row);
	}

	/** aria-checked mirrors "panel open"; the is-on class tints the buddies
	 * icon apricot - the row's only signal. */
	function syncRow(row) {
		row.setAttribute('aria-checked', String(panelOpen));
		row.classList.toggle('is-on', panelOpen);
	}

	function removeHomeControls() {
		document.getElementById(ROW_ID)?.remove();
	}

	// --- wiring: pure consumer, registered before content.js's first ytb:navigate ---

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
		removeHomeControls();
	});

	/** An inline SVG glyph (fill follows currentColor). */
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

	/** Inject the row stylesheet once (light + html[dark]). Every metric below
	 * was measured off a production guide entry, and written out directly
	 * since today's markup no longer exposes --yt-spec-* custom properties. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${ROW_ID} {
        /* The icon color is the row's only ON/OFF signal (UA-015): deep
           apricot reads at 3:1+ on the white light guide; html[dark] lifts
           it back to the bright apricot, which reads on the dark guide. */
        --ytbht-accent: #c7712f;
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
      html[dark] #${ROW_ID} { color: #f1f1f1; --ytbht-accent: #f6a96b; }
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
      ytd-mini-guide-renderer #${ROW_ID} {
        width: 64px;
        height: 76px;
        flex-direction: column;
        justify-content: flex-start;
        padding: 16px 0 14px;
        font-size: 10px;
        line-height: 16px;
        text-align: center;
      }
      ytd-mini-guide-renderer #${ROW_ID} .ytb-ht-icon {
        margin: 0 0 6px;
      }
      @media (prefers-reduced-motion: reduce) {
		#${ROW_ID} .ytb-ht-icon { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
