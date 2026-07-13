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
//
// This module also hosts the Control Panel Launcher: a control-knobs (sliders)
// icon pinned to the RIGHT end of the toggle row that opens the full Control
// Panel (popup.html) in an in-page overlay — an extension-origin iframe over a
// dim scrim, closed by its x / Esc / a scrim click and focus-trapped while
// open. It lives in the row (not the Room Home Section) so it stays reachable
// whether the section is shown or hidden, and its click stops propagation so it
// opens the panel WITHOUT flipping the toggle. Because the iframe is the same
// document at the extension origin, any Room join / Setting change made inside
// it propagates to every in-page surface through the existing
// chrome.storage.onChanged listeners — no message wiring (ADR-0001 preserved:
// the iframe, not this script, reaches the popup's APIs).

(function () {
	'use strict';

	const ROW_ID = 'ytb-home-toggle';
	const LAUNCHER_CLASS = 'ytb-ht-launcher';
	const OVERLAY_ID = 'ytb-panel-overlay';
	const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
	const STYLE_ID = 'ytb-home-toggle-style';
	const SVG_NS = 'http://www.w3.org/2000/svg';
	// A control-knobs "tune" glyph (Material "tune"): three sliders with knobs.
	// Deliberately NOT a gear — the launcher opens the whole Control Panel hub,
	// not just its Settings view.
	const TUNE_PATH =
		'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z';
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

		// The Control Panel Launcher, pinned to the row's right end. A role=button
		// span (not a nested <button>, which is invalid inside the row button); it
		// swallows its own activation so opening the panel never flips the toggle.
		const launcher = document.createElement('span');
		launcher.className = LAUNCHER_CLASS;
		launcher.setAttribute('role', 'button');
		launcher.tabIndex = 0;
		launcher.setAttribute('aria-label', 'Open the Control Panel');
		launcher.title = 'Control Panel';
		launcher.append(buildIcon(TUNE_PATH, 20));
		launcher.addEventListener('click', (event) => {
			event.stopPropagation();
			openPanel();
		});
		launcher.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			openPanel();
		});

		row.append(iconWrap, label, launcher);

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
	// Control Panel overlay: an extension-origin iframe of popup.html over a dim
	// scrim, closed by its x / Esc / a scrim click and focus-trapped while open.
	// ---------------------------------------------------------------------------

	let lastFocus = null; // restored to the launcher when the panel closes

	function isPanelOpen() {
		return !!document.getElementById(OVERLAY_ID);
	}

	function openPanel() {
		if (!YTB.isContextActive() || isPanelOpen()) return;
		lastFocus = document.activeElement;

		const overlay = document.createElement('div');
		overlay.id = OVERLAY_ID;

		// Sentinels bookend the card: a Tab that leaves it — including out of the
		// cross-origin iframe, where our keydown listener is blind — resurfaces to
		// a focusable node we own and is wrapped back inside (the focus trap).
		const guardStart = focusGuard();
		const guardEnd = focusGuard();

		const card = document.createElement('div');
		card.className = 'ytb-panel-card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		card.setAttribute('aria-label', 'Control Panel');

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'ytb-panel-close';
		closeBtn.setAttribute('aria-label', 'Close');
		closeBtn.append(YTBTheme.icon('close'));
		closeBtn.addEventListener('click', closePanel);

		const frame = document.createElement('iframe');
		frame.className = 'ytb-panel-frame';
		frame.title = 'Control Panel';
		frame.src = chrome.runtime.getURL('popup.html');

		guardStart.addEventListener('focus', () => frame.focus());
		guardEnd.addEventListener('focus', () => closeBtn.focus());

		card.append(closeBtn, frame);
		overlay.append(guardStart, card, guardEnd);
		// A click that lands on the scrim itself (never one bubbling from the card)
		// closes; mousedown-origin guards against a drag that ends on the scrim.
		overlay.addEventListener('mousedown', (event) => {
			if (event.target === overlay) closePanel();
		});

		document.addEventListener('keydown', onPanelKeydown, true);
		// The iframe is a different origin than this page, so the host can't read
		// its height; the popup posts it and we size the card snugly per view.
		window.addEventListener('message', onPanelMessage);
		(document.body || document.documentElement).appendChild(overlay);
		// Land focus on the close chip so Esc/Tab work at once and focus leaves the
		// launcher (which we restore it to on close).
		closeBtn.focus();
	}

	function closePanel() {
		const overlay = document.getElementById(OVERLAY_ID);
		if (!overlay) return;
		document.removeEventListener('keydown', onPanelKeydown, true);
		window.removeEventListener('message', onPanelMessage);
		overlay.remove();
		if (lastFocus && lastFocus.isConnected) {
			try {
				lastFocus.focus();
			} catch {
				/* element gone — nothing to restore focus to */
			}
		}
		lastFocus = null;
	}

	function onPanelKeydown(event) {
		if (event.key !== 'Escape' || !isPanelOpen()) return;
		event.preventDefault();
		event.stopPropagation();
		closePanel();
	}

	/** Size the card to the popup's reported content height (see popup.js). Only
	 * our own iframe at the extension origin is trusted; the CSS max-height caps
	 * it to the viewport. */
	function onPanelMessage(event) {
		if (event.origin !== EXT_ORIGIN) return;
		const overlay = document.getElementById(OVERLAY_ID);
		const frame = overlay && overlay.querySelector('.ytb-panel-frame');
		if (!frame || event.source !== frame.contentWindow) return;
		const data = event.data;
		if (!data || data.type !== 'ytb:panel-height' || typeof data.height !== 'number') return;
		const card = overlay.querySelector('.ytb-panel-card');
		if (card) card.style.height = `${Math.max(0, Math.round(data.height))}px`;
	}

	/** A visually-inert tabbable sentinel used to wrap focus back into the card. */
	function focusGuard() {
		const guard = document.createElement('div');
		guard.tabIndex = 0;
		guard.setAttribute('aria-hidden', 'true');
		guard.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:0;overflow:hidden;';
		return guard;
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer, registered synchronously (before content.js fires
	// the initial ytb:navigate).
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', () => {
		if (!YTB.isContextActive()) return;
		onHome = isHomePath();
		// The launcher only exists on the home route; a route change takes its
		// panel with it.
		if (!onHome) closePanel();
		ensureRow();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		// YouTube rebuilds the guide lazily; keep the row present without churn.
		ensureRow();
	});

	YTB.onContextInvalidated(() => {
		closePanel();
		document.getElementById(ROW_ID)?.remove();
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

      /* Control Panel overlay: a centered card holding the popup.html iframe over
         a dim scrim. Chrome (card, close chip) uses the theme.js --ytb-* tokens
         so it follows the same Light/Dark preference as the on-video surfaces. */
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: oklch(22% 0.02 52 / 0.5);
        animation: ytb-panel-fade 140ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      #${OVERLAY_ID} .ytb-panel-card {
        position: relative;
        width: 320px;
        max-width: calc(100vw - 48px);
        height: 460px;                       /* seed; popup.js posts the snug height */
        max-height: calc(100vh - 48px);
        border-radius: var(--ytb-r-lg, 16px);
        background: var(--ytb-surface, #fff);
        box-shadow: var(--ytb-e-dialog, 0 14px 40px rgba(0, 0, 0, 0.5));
        animation: ytb-panel-pop 200ms cubic-bezier(0.34, 1.3, 0.64, 1) both;
      }
      #${OVERLAY_ID} .ytb-panel-frame {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        border-radius: inherit;
        background: transparent;
      }
      #${OVERLAY_ID} .ytb-panel-close {
        position: absolute;
        top: -12px;
        right: -12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 1px solid var(--ytb-line, rgba(0, 0, 0, 0.1));
        border-radius: 999px;
        background: var(--ytb-surface, #fff);
        color: var(--ytb-ink-muted, #555);
        cursor: pointer;
        box-shadow: var(--ytb-e-pop, 0 6px 20px rgba(0, 0, 0, 0.25));
        transition: color 140ms, background 140ms;
      }
      #${OVERLAY_ID} .ytb-panel-close:hover {
        color: var(--ytb-ink, #111);
        background: var(--ytb-accent-100, #f6e6d8);
      }
      #${OVERLAY_ID} .ytb-panel-close:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--ytb-ring, rgba(246, 169, 107, 0.55));
      }
      #${OVERLAY_ID} .ytb-panel-close svg { display: block; width: 16px; height: 16px; }
      @keyframes ytb-panel-fade { from { opacity: 0; } }
      @keyframes ytb-panel-pop { from { opacity: 0; transform: scale(0.97); } }

      @media (prefers-reduced-motion: reduce) {
        #${ROW_ID} .ytb-ht-icon,
        #${ROW_ID} .${LAUNCHER_CLASS} { transition: none; }
        #${OVERLAY_ID},
        #${OVERLAY_ID} .ytb-panel-card { animation: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
