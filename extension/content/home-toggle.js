// extension/home-toggle.js
//
// The Room Home Toggle: a "Buddy Room" row injected into YouTube's left
// guide on the home route, pixel-matched to native entries, controlling
// whether home-section.js renders. State lives in chrome.storage.local.
// Guide-DOM targeting is deliberately fragile, contained to this module
// (ADR-0001 pure consumer): retried on content.js's throttled ytb:mutation
// until the guide exists. Also hosts the Control Panel Launcher (ADR-0012).

(function () {
	'use strict';

	const ROW_ID = 'ytb-home-toggle';
	const LAUNCHER_CLASS = 'ytb-ht-launcher';
	const RELAY_ID = 'ytb-control-panel-relay';
	const RELAY_PAGE = 'pages/control-panel-relay.html';
	const OPEN_MESSAGE = 'ytb:open-control-panel';
	const OPEN_FAILED_MESSAGE = 'ytb:open-control-panel-failed';
	const TOOLBAR_FALLBACK_COPY = 'Open YouTube Buddy from the toolbar icon';
	const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
	const STYLE_ID = 'ytb-home-toggle-style';
	const SVG_NS = 'http://www.w3.org/2000/svg';
	// A control-knobs "tune" glyph (Material "tune"), deliberately not a gear -
	// the launcher opens the whole Control Panel hub, not just Settings.
	const TUNE_PATH =
		'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z';
	// A two-person "buddies" glyph (Material "people"): hidden, it inherits the
	// row text color (measured off native guide icons, rgb(15,15,15) light /
	// rgb(241,241,241) dark) to match Home/Shorts/Subscriptions; shown, it
	// flips to the apricot accent - the row's only ON/OFF signal.
	const PEOPLE_PATH =
		'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z';

	let onHome = false;
	let hidden = null; // null until the stored preference has been read
	let flipping = false; // one persisted flip at a time
	let relayLoaded = false;

	injectStyle();

	YTB.getHomeSectionHidden().then((value) => {
		if (hidden === null) hidden = value;
		ensureRow();
	});

	// A popup-Settings flip of homeSectionHidden reflects here live (our own
	// click also lands here - idempotent).
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

	/** The guide slot the row lives in, with fallbacks for shifted markup; null
	 * while the guide isn't built yet (retried on mutation). */
	function guideSlot() {
		const guide = document.querySelector('ytd-guide-renderer');
		if (!guide) return null;
		return guide.querySelector('#sections ytd-guide-section-renderer #items') || guide.querySelector('#sections') || guide;
	}

	function ensureRow() {
		if (!YTB.isContextActive()) return;
		// Off the home route (or before state is known) the row has no business
		// here; the section module gates itself the same way.
		if (!onHome || hidden === null) {
			removeHomeControls();
			return;
		}
		let row = document.getElementById(ROW_ID);
		if (row && row.isConnected) {
			ensureRelayFrame(row.parentNode);
			return;
		}

		const slot = guideSlot();
		if (!slot) return; // guide not built yet - a later ytb:mutation retries

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

		// Control Panel Launcher: a role=button span (a nested <button> is
		// invalid here) that swallows its own activation so it never flips the toggle.
		const launcher = document.createElement('span');
		launcher.className = LAUNCHER_CLASS;
		launcher.setAttribute('role', 'button');
		launcher.tabIndex = 0;
		launcher.setAttribute('aria-label', 'Open the Control Panel');
		launcher.title = 'Control Panel';
		launcher.append(buildIcon(TUNE_PATH, 20));
		launcher.addEventListener('click', (event) => {
			event.stopPropagation();
			openControlPanel();
		});
		launcher.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			openControlPanel();
		});

		row.append(iconWrap, label, launcher);

		row.addEventListener('click', async () => {
			if (flipping || hidden === null) return;
			flipping = true;
			hidden = !hidden;
			syncRow(row);
			await YTB.setHomeSectionHidden(hidden);
			flipping = false;
			// home-section.js also reads the stored preference on load, so neither
			// module depends on the other having run first.
			document.dispatchEvent(new CustomEvent('ytb:home-section-visibility', { detail: { hidden } }));
		});

		syncRow(row);
		slot.append(row, ensureRelayFrame(slot));
	}

	/** aria-checked mirrors "section shown"; the is-on class tints the buddies
	 * icon apricot - the row's only signal. */
	function syncRow(row) {
		const shown = hidden === false;
		row.setAttribute('aria-checked', String(shown));
		row.classList.toggle('is-on', shown);
	}

	/** Hidden extension-origin frame that can call chrome.action.openPopup, so
	 * this content script needs no background service worker (ADR-0012). A
	 * sibling of the row, so YouTube tearing down the guide removes both. */
	function ensureRelayFrame(slot) {
		let frame = document.getElementById(RELAY_ID);
		if (frame && frame.isConnected) return frame;
		frame?.remove();
		relayLoaded = false;
		frame = document.createElement('iframe');
		frame.id = RELAY_ID;
		frame.tabIndex = -1;
		frame.setAttribute('aria-hidden', 'true');
		frame.title = '';
		frame.addEventListener('load', () => {
			if (frame.isConnected) relayLoaded = true;
		});
		frame.src = chrome.runtime.getURL(RELAY_PAGE);
		if (slot && !frame.isConnected) slot.appendChild(frame);
		return frame;
	}

	function openControlPanel() {
		if (!YTB.isContextActive() || !onHome) return;
		const row = document.getElementById(ROW_ID);
		const frame = ensureRelayFrame(row && row.parentNode);
		const send = () => {
			try {
				frame.contentWindow?.postMessage({ type: OPEN_MESSAGE }, EXT_ORIGIN);
			} catch {
				YTB.toast(TOOLBAR_FALLBACK_COPY);
			}
		};
		if (relayLoaded) send();
		else frame.addEventListener('load', send, { once: true });
	}

	/** Only a failure from our current extension frame can trigger fallback UI. */
	function onRelayMessage(event) {
		if (event.origin !== EXT_ORIGIN || event.data?.type !== OPEN_FAILED_MESSAGE) return;
		const frame = document.getElementById(RELAY_ID);
		if (!frame || event.source !== frame.contentWindow) return;
		YTB.toast(TOOLBAR_FALLBACK_COPY);
	}

	function removeHomeControls() {
		relayLoaded = false;
		document.getElementById(RELAY_ID)?.remove();
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

	window.addEventListener('message', onRelayMessage);

	YTB.onContextInvalidated(() => {
		window.removeEventListener('message', onRelayMessage);
		removeHomeControls();
	});

	/** An inline SVG glyph (fill follows currentColor). Defaults to the left
	 * buddies people glyph; the launcher passes the "tune" sliders path. */
	function buildIcon(pathData = PEOPLE_PATH, size = 24) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', pathData);
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
      /* Control Panel Launcher: pinned to the row's right end, native color at
         rest, apricot on hover/focus. It carries no hover background of its own
         (the row's own hover already lights up behind it) so the toggle icon
         keeps the ON/OFF apricot as the row's sole state signal. */
      #${ROW_ID} .${LAUNCHER_CLASS} {
        flex: none;
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        color: inherit;
        cursor: pointer;
        transition: color 140ms;
      }
      #${ROW_ID} .${LAUNCHER_CLASS}:hover { color: var(--ytbht-accent); }
      #${ROW_ID} .${LAUNCHER_CLASS}:focus-visible {
        outline: none;
        color: var(--ytbht-accent);
        box-shadow: 0 0 0 2px var(--ytbht-accent);
      }
      #${ROW_ID} .${LAUNCHER_CLASS} svg { display: block; width: 20px; height: 20px; }

      #${RELAY_ID} {
        position: fixed;
        width: 0;
        height: 0;
        border: 0;
        visibility: hidden;
        pointer-events: none;
      }

      @media (prefers-reduced-motion: reduce) {
        #${ROW_ID} .ytb-ht-icon,
        #${ROW_ID} .${LAUNCHER_CLASS} { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
