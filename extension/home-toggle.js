// extension/home-toggle.js
//
// The Room Home Toggle: a very small on/off switch injected as a row into
// YouTube's own left guide (sidebar) on the home route, controlling whether
// the Room Home Section (home-section.js) renders at all. Off removes the
// section completely; the toggle row itself stays in the guide so it can be
// turned back on. The state persists per install in chrome.storage.local
// (shared.js getHomeSectionHidden/setHomeSectionHidden) and only affects the
// home surface — on-video markers, Notes, presence, and the watch-page
// control are untouched.
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

		const dot = document.createElement('span');
		dot.className = 'ytb-ht-dot';
		const label = document.createElement('span');
		label.className = 'ytb-ht-label';
		label.textContent = 'Buddy Room';
		const track = document.createElement('span');
		track.className = 'ytb-ht-track';
		const knob = document.createElement('span');
		knob.className = 'ytb-ht-knob';
		track.append(knob);
		row.append(dot, label, track);

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

	/** Reflect the current state: checked means the section is shown. */
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

	/** Inject the row stylesheet once (light + html[dark] themes). */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${ROW_ID} {
        --ytbht-ink: #3a2e28;
        --ytbht-ink-muted: #7a6656;
        --ytbht-line: #ece1d6;
        --ytbht-accent: #f6a96b;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 8px;
        width: calc(100% - 24px);
        margin: 2px 12px;
        padding: 5px 10px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--ytbht-ink);
        font-family: Nunito, ui-rounded, 'SF Pro Rounded', Roboto, system-ui, sans-serif;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        text-align: left;
        cursor: pointer;
      }
      html[dark] #${ROW_ID} {
        --ytbht-ink: #f4ece2;
        --ytbht-ink-muted: #b3a091;
        --ytbht-line: #3d332c;
      }
      #${ROW_ID}:hover { background: rgba(246, 169, 107, 0.14); }
      #${ROW_ID}:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(246, 169, 107, 0.55); }
      #${ROW_ID} .ytb-ht-dot {
        flex: none;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--ytbht-accent);
      }
      #${ROW_ID} .ytb-ht-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${ROW_ID} .ytb-ht-track {
        flex: none;
        position: relative;
        width: 26px; height: 14px;
        border-radius: 7px;
        background: var(--ytbht-line);
        transition: background 140ms;
      }
      #${ROW_ID}.is-on .ytb-ht-track { background: var(--ytbht-accent); }
      #${ROW_ID} .ytb-ht-knob {
        position: absolute;
        top: 2px; left: 2px;
        width: 10px; height: 10px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #${ROW_ID}.is-on .ytb-ht-knob { transform: translateX(12px); }
      @media (prefers-reduced-motion: reduce) {
        #${ROW_ID} .ytb-ht-track, #${ROW_ID} .ytb-ht-knob { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
