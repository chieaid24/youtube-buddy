// extension/playlist-add.js
//
// The two Recommend Controls (the Recommended-for-you grid itself renders in
// home-section.js; ADR-0007), sharing one vocabulary (see CONTEXT.md
// "Recommend Control"):
//   1. Watch page: a "Recommend to Buddies" pill appended to the actions row
//      that holds Like/Share/Save — a self-owned sibling, apricot and visually
//      distinct from YouTube's Save. On a video the viewer recommended it
//      shows an "Unrecommend" toggle state — the action it offers, not the
//      state it reports; clicking it un-recommends (the author-only point
//      delete that removes the Recommendation for everyone).
//   2. Any thumbnail: a "Recommend to Buddies" row appended to the tile's
//      three-dots menu, next to YouTube's own Save-to-playlist items.
//
// The kebab injection DELIBERATELY accepts YouTube-menu DOM fragility (an
// explicit product decision — see issue #56 / ADR-0005 notes): the risk is
// contained to this one module, hooked only through content.js's throttled
// ytb:mutation events, and the watch-page pill stays a self-owned fallback.
//
// Pure consumer per ADR-0001. Only rendered/enabled while a Room Code is set
// (an Unpaired install pairs via the popup or the Room Home Section first).
// Adding is NOT gated by Sharing — curating the Room's list is an explicit
// act, not position reporting.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-playlist-add-button';
	const KEBAB_ITEM_CLASS = 'ytb-kebab-add';
	const STYLE_ID = 'ytb-playlist-add-style';
	const FEEDBACK_ID = 'ytb-playlist-feedback';
	const FEEDBACK_MS = 2000;

	let currentVideoId = null;
	// From ytb:room-data: videoId -> the recommending member's clientId
	// (addedBy). Powers the pill's three states: absent = idle ("Recommend to
	// Buddies"), mine = "Unrecommend" (click to un-recommend), a Buddy's =
	// "Recommended to you".
	let recommenderByVideoId = new Map();
	let myClientId = null;
	let hasRoomCode = false;
	let feedbackTimer = null;
	// The tile whose kebab was last clicked; consumed when its menu popup opens.
	let pendingKebab = null; // { videoId, title, at }

	injectStyle();

	function errorLabel(category) {
		if (category === 'network') return YTB.errorCopy(category, 'recommendation');
		if (category === 'playlist_full') return 'Room list full';
		if (category === 'room_full') return 'Room full';
		return "Couldn't add";
	}

	async function addToPlaylist(videoId, title) {
		const clientId = await YTB.ensureClientId();
		const { name } = await YTB.getConfig();
		if (!YTB.isContextActive()) return { ok: false, category: 'unexpected' };
		myClientId = myClientId || clientId;
		const result = await YTB.postPlaylistAdd({ clientId, name, videoId, title });
		// The server record is authoritative: re-recommending a video a Buddy
		// already recommended is a no-op that returns THEIR item (addedBy stays
		// theirs), so the pill must not claim it as ours.
		if (result.ok) recommenderByVideoId.set(videoId, (result.item && result.item.addedBy) || clientId);
		return result;
	}

	// ---------------------------------------------------------------------------
	// Watch page: the "Recommend to Buddies" pill in the actions row.
	// ---------------------------------------------------------------------------

	function ensureWatchButton() {
		if (!YTB.isContextActive()) return;
		if (!currentVideoId || !hasRoomCode) {
			document.getElementById(BUTTON_ID)?.remove();
			return;
		}
		// The row holding Like/Share/Save on the watch page. When Save hides
		// under the "..." overflow, the pill still sits in the same row — an
		// accepted open tuning point (see the issue's Further Notes).
		const actions = document.querySelector('ytd-watch-metadata #actions #top-level-buttons-computed');
		if (!actions) return; // metadata not built yet — a later ytb:mutation retries

		let button = document.getElementById(BUTTON_ID);
		if (!button) {
			button = document.createElement('button');
			button.id = BUTTON_ID;
			button.type = 'button';
			button.addEventListener('click', async (event) => {
				event.stopPropagation();
				const state = button.dataset.ytbState;
				const videoId = currentVideoId;
				if (state === 'idle') {
					setButtonState(button, 'busy');
					const result = await addToPlaylist(videoId, YTB.watchTitle(document));
					if (!button.isConnected) return;
					if (result.ok) {
						syncWatchButton(button);
					} else {
						const message = errorLabel(result.category);
						flashButton(button, result.category === 'network' ? STATE_LABELS.idle : message, message);
					}
				} else if (state === 'recommended') {
					// Un-recommend (ADR-0007): the author-only point delete that
					// removes this Recommendation for EVERYONE (and emits no event).
					setButtonState(button, 'busy', 'Unrecommending...');
					const clientId = await YTB.ensureClientId();
					if (!YTB.isContextActive()) return;
					const result = await YTB.deletePlaylistItem({ clientId, videoId });
					if (!button.isConnected) return;
					if (result.ok) {
						recommenderByVideoId.delete(videoId);
						syncWatchButton(button);
					} else {
						const message = result.category === 'network' ? errorLabel(result.category) : "Couldn't unrecommend";
						flashButton(button, result.category === 'network' ? STATE_LABELS.recommended : message, message);
					}
				}
			});
		}
		if (button.parentElement !== actions) actions.appendChild(button);
		if (!feedbackTimer) syncWatchButton(button);
	}

	const STATE_LABELS = {
		idle: 'Recommend to Buddies',
		busy: 'Recommending...',
		added: 'Recommended to you', // a Buddy's Recommendation — nothing to toggle
		recommended: 'Unrecommend', // mine — the action offered, click to un-recommend
	};

	function setButtonState(button, state, label) {
		button.dataset.ytbState = state;
		button.textContent = label || STATE_LABELS[state] || STATE_LABELS.idle;
		button.removeAttribute('aria-describedby');
		button.disabled = state === 'busy';
		button.classList.toggle('is-added', state === 'added');
		button.classList.toggle('is-recommended', state === 'recommended');
		button.title = state === 'recommended' ? 'You recommended this to your Buddies. Click to remove it for everyone.' : '';
	}

	function pillState() {
		const addedBy = recommenderByVideoId.get(currentVideoId);
		if (addedBy === undefined) return 'idle';
		return myClientId && addedBy === myClientId ? 'recommended' : 'added';
	}

	function syncWatchButton(button) {
		setButtonState(button, pillState());
	}

	function flashButton(button, label, message = '') {
		document.getElementById(FEEDBACK_ID)?.remove();
		setButtonState(button, 'error', label);
		if (message && message !== label) {
			const feedback = document.createElement('span');
			feedback.id = FEEDBACK_ID;
			feedback.className = 'ytb-playlist-feedback';
			feedback.setAttribute('role', 'status');
			feedback.textContent = message;
			(document.body || document.documentElement).append(feedback);
			button.setAttribute('aria-describedby', FEEDBACK_ID);
			const anchor = button.getBoundingClientRect();
			const width = feedback.offsetWidth;
			const height = feedback.offsetHeight;
			feedback.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width)) + 'px';
			const below = anchor.bottom + 8;
			feedback.style.top = (below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 8)) + 'px';
		}
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = setTimeout(() => {
			feedbackTimer = null;
			document.getElementById(FEEDBACK_ID)?.remove();
			if (button.isConnected) syncWatchButton(button);
		}, FEEDBACK_MS);
	}

	// ---------------------------------------------------------------------------
	// Thumbnails: the "Recommend to Buddies" row in a tile's three-dots menu.
	//
	// Flow: a capture-phase click listener notices a click inside a tile's
	// ytd-menu-renderer (the kebab) and remembers that tile's videoId + title;
	// the menu popup itself is rendered later into a top-level
	// tp-yt-iron-dropdown, so the next ytb:mutation injects our row into the
	// open menu list and consumes the pending capture.
	//
	// Two live menu generations (verified against real YouTube markup):
	//   - classic tiles (ytd-video-renderer & co):
	//       tp-yt-iron-dropdown > ytd-menu-popup-renderer > tp-yt-paper-listbox
	//   - lockup tiles (yt-lockup-view-model — today's home grid + watch-related):
	//       tp-yt-iron-dropdown > yt-sheet-view-model > yt-contextual-sheet-layout
	//         > yt-list-view-model[role="menu"]
	// YouTube reuses ONE dropdown node for successive popups, so an injected row
	// must never outlive its menu: rows in a closed dropdown are removed, and a
	// fresh capture replaces any row left from a previous tile.
	// ---------------------------------------------------------------------------

	const TILE_SELECTOR =
		'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model';

	function videoIdFromHref(href) {
		if (!href) return null;
		try {
			const u = new URL(href, location.href);
			return u.pathname === '/watch' ? u.searchParams.get('v') : null;
		} catch {
			return null;
		}
	}

	document.addEventListener(
		'click',
		(event) => {
			if (!YTB.isContextActive() || !hasRoomCode) return;
			const target = event.target instanceof Element ? event.target : null;
			// The kebab lives in a ytd-menu-renderer (classic tiles) or a
			// button-shape with an "options/more" aria label (lockup tiles).
			const trigger = target && (target.closest('ytd-menu-renderer') || target.closest('yt-icon-button, button'));
			if (!trigger) return;
			const tile = trigger.closest(TILE_SELECTOR);
			if (!tile || tile.closest('#ytb-home-section')) return;
			const anchor = tile.querySelector('a[href*="/watch?v="]');
			const videoId = anchor && videoIdFromHref(anchor.getAttribute('href'));
			if (!videoId) return;
			// Lockup tiles carry the clean title on .ytLockupMetadataViewModelTitle
			// (the older -wiz__ spelling is kept for stragglers); classic tiles on
			// #video-title. Any other a[title] is a last-resort fallback only.
			const titleEl =
				tile.querySelector('#video-title, .ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model-wiz__title') ||
				tile.querySelector('a[title]');
			const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '';
			pendingKebab = { videoId, title: title.trim() || 'Untitled video', at: Date.now() };
		},
		true,
	);

	/** The list element of the currently open tile menu, across both menu
	 * generations, or null while no menu is open. */
	function openMenuList() {
		for (const dropdown of document.querySelectorAll('tp-yt-iron-dropdown:not([aria-hidden="true"])')) {
			if (dropdown.style.display === 'none') continue; // closed but not yet re-hidden
			// Classic tiles: the paper listbox inside the menu popup renderer.
			const popup = dropdown.querySelector('ytd-menu-popup-renderer');
			if (popup) return popup.querySelector('tp-yt-paper-listbox') || popup;
			// Lockup tiles: the sheet's list view model.
			const sheet = dropdown.querySelector('yt-sheet-view-model');
			if (sheet) return sheet.querySelector('yt-list-view-model') || sheet;
		}
		return null;
	}

	function syncKebabMenu() {
		// A row must never outlive its menu: YouTube reuses one dropdown node for
		// every popup, so a survivor would resurface under the wrong menu (another
		// tile's, or an unrelated popup's) and recommend the wrong video.
		for (const row of document.querySelectorAll('.' + KEBAB_ITEM_CLASS)) {
			const host = row.closest('tp-yt-iron-dropdown');
			if (!host || host.getAttribute('aria-hidden') === 'true' || host.style.display === 'none') row.remove();
		}

		if (!pendingKebab || !hasRoomCode) return;
		// A stale capture (no menu ever opened) expires quietly.
		if (Date.now() - pendingKebab.at > 3000) {
			pendingKebab = null;
			return;
		}
		const listbox = openMenuList();
		if (!listbox) return; // menu not open (yet) — keep the capture until it expires

		const { videoId, title } = pendingKebab;
		pendingKebab = null;
		// A fresh capture wins over any row left from a previously shown menu.
		listbox.querySelector('.' + KEBAB_ITEM_CLASS)?.remove();

		const item = document.createElement('div');
		item.className = KEBAB_ITEM_CLASS;
		item.setAttribute('role', 'menuitem');
		item.tabIndex = 0;
		const icon = document.createElement('span');
		icon.className = 'ytb-kebab-add-icon';
		icon.textContent = '+';
		const label = document.createElement('span');
		label.textContent = 'Recommend to Buddies';
		item.append(icon, label);

		const activate = async () => {
			label.textContent = 'Recommending...';
			const result = await addToPlaylist(videoId, title);
			label.textContent = result.ok ? 'Recommended' : errorLabel(result.category);
			item.classList.toggle('is-network-error', !result.ok && result.category === 'network');
			fitOpenMenu(item);
			setTimeout(() => {
				// Close the menu the way YouTube would.
				const open = item.closest('tp-yt-iron-dropdown');
				if (open && typeof open.close === 'function') open.close();
				else item.closest('ytd-popup-container')?.querySelector('tp-yt-iron-dropdown')?.setAttribute('aria-hidden', 'true');
			}, 650);
		};
		item.addEventListener('click', (event) => {
			event.stopPropagation();
			activate();
		});
		item.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				activate();
			}
		});

		listbox.appendChild(item);
		fitOpenMenu(item);
	}

	/** After the row lands in an open menu, the popup must show it WITHOUT the
	 * user scrolling — in both menu generations. YouTube sizes the popup before
	 * the row exists, so any inline pixel max-height between the row and its
	 * dropdown is now one row short: grow each by the row's height, then let
	 * the dropdown re-measure and re-position itself (iron-dropdown's refit)
	 * in case the taller menu would overflow the viewport. */
	function fitOpenMenu(item) {
		const dropdown = item.closest('tp-yt-iron-dropdown');
		if (!dropdown) return;
		const rowHeight = item.offsetHeight || 36;
		const previousHeight = Number(item.dataset.ytbFittedHeight) || 0;
		const growth = Math.max(0, rowHeight - previousHeight);
		item.dataset.ytbFittedHeight = String(rowHeight);
		let node = item.parentElement;
		while (node) {
			const inline = node.style ? node.style.maxHeight : '';
			if (inline && inline.endsWith('px')) {
				const current = parseFloat(inline);
				if (Number.isFinite(current)) node.style.maxHeight = current + growth + 'px';
			}
			if (node === dropdown) break;
			node = node.parentElement;
		}
		try {
			if (typeof dropdown.refit === 'function') dropdown.refit();
		} catch {
			// A dropdown mid-close/detach can't refit; the row is swept anyway.
		}
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer, registered synchronously.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', async (event) => {
		if (!YTB.isContextActive()) return;
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = null;
		document.getElementById(FEEDBACK_ID)?.remove();
		currentVideoId = (event.detail && event.detail.videoId) || null;
		pendingKebab = null;
		const { code } = await YTB.getConfig();
		hasRoomCode = Boolean(code);
		ensureWatchButton();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		ensureWatchButton();
		syncKebabMenu();
	});

	document.addEventListener('ytb:room-data', (event) => {
		if (!YTB.isContextActive()) return;
		const detail = (event && event.detail) || {};
		hasRoomCode = Boolean(detail.roomCode);
		myClientId = detail.myClientId || myClientId;
		recommenderByVideoId = new Map((detail.playlist || []).map((item) => [item.videoId, item.addedBy]));
		const button = document.getElementById(BUTTON_ID);
		if (button && !feedbackTimer) syncWatchButton(button);
		if (!hasRoomCode) document.getElementById(BUTTON_ID)?.remove();
	});

	YTB.onContextInvalidated(() => {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = null;
		document.getElementById(FEEDBACK_ID)?.remove();
		document.getElementById(BUTTON_ID)?.remove();
		for (const item of document.querySelectorAll('.' + KEBAB_ITEM_CLASS)) item.remove();
	});

	/** Inject the styles once: apricot pill + menu row, quirky on purpose. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* The pill consumes the shared --ytb-* tokens like every sibling YTB
       * surface (UA-010): the design face, theme-aware accent roles, and the
       * r-pill radius. A transparent border keeps the label inset identical
       * across the filled and outline states. 14px matches YouTube's actions
       * row on purpose. */
      #${BUTTON_ID} {
        margin-left: 8px;
        padding: 0 16px;
        height: 36px;
        border: 1px solid transparent;
        border-radius: var(--ytb-r-pill, 999px);
        background: var(--ytb-accent-500, #f6a96b);
        color: var(--ytb-on-accent, #3a2e28);
        font: 500 14px/34px var(--ytb-font, ui-rounded, Roboto, Arial, sans-serif);
        cursor: pointer;
        white-space: nowrap;
        transition: transform var(--ytb-dur-quick, 140ms) var(--ytb-ease-spring, cubic-bezier(0.34, 1.3, 0.64, 1)), background var(--ytb-dur-quick, 140ms);
      }
      #${BUTTON_ID}:hover { background: var(--ytb-accent-600, #e88b45); }
      #${BUTTON_ID}:active { transform: scale(0.97); }
      #${BUTTON_ID}:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring, rgba(246, 169, 107, 0.55)); }
      /* Outline states read as text on the page itself: the raw apricot fill
       * misses AA there (1.94:1 on a light page), so they use the deep
       * accent-800 text role, which flips bright on the dark theme (UA-002). */
      #${BUTTON_ID}.is-added { background: transparent; border: 1px solid var(--ytb-accent-800, #9e551f); color: var(--ytb-accent-800, #9e551f); cursor: default; line-height: 34px; }
      #${BUTTON_ID}.is-recommended { background: transparent; border: 1px solid var(--ytb-accent-800, #9e551f); color: var(--ytb-accent-800, #9e551f); line-height: 34px; }
      #${BUTTON_ID}.is-recommended:hover { background: rgba(246, 169, 107, 0.14); }
      #${BUTTON_ID}:disabled { opacity: 0.7; cursor: default; }
	  #${FEEDBACK_ID} {
		position: fixed;
		z-index: 2147483647;
		box-sizing: border-box;
		width: 280px;
		padding: 8px 12px;
		border: 1px solid var(--ytb-line-strong, rgba(58, 46, 40, 0.2));
		border-radius: var(--ytb-r-sm, 8px);
		background: var(--ytb-surface, #fffaf6);
		box-shadow: var(--ytb-e-pop, 0 8px 24px rgba(30, 20, 14, 0.2));
		color: var(--ytb-danger-text, #a53b20);
		font: 600 12px/1.35 var(--ytb-font, Nunito, ui-rounded, Roboto, Arial, sans-serif);
		white-space: normal;
		pointer-events: none;
	  }
      .${KEBAB_ITEM_CLASS} {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 36px;
        padding: 0 12px 0 16px;
        color: #f6a96b;
        font: 400 14px/36px Roboto, Arial, sans-serif;
        cursor: pointer;
        white-space: nowrap;
      }
      .${KEBAB_ITEM_CLASS}:hover, .${KEBAB_ITEM_CLASS}:focus-visible {
        background: rgba(246, 169, 107, 0.14);
        outline: none;
      }
	  .${KEBAB_ITEM_CLASS}.is-network-error {
		box-sizing: border-box;
		max-width: 320px;
		padding-top: 8px;
		padding-bottom: 8px;
		line-height: 1.35;
		white-space: normal;
	  }
      .ytb-kebab-add-icon {
        width: 24px;
        text-align: center;
        font-size: 18px;
        font-weight: 700;
      }
      @media (prefers-reduced-motion: reduce) {
        #${BUTTON_ID} { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
