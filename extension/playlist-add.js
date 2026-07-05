// extension/playlist-add.js
//
// The two Shared Playlist ADD entry points (the Section itself renders in
// home-section.js):
//   1. Watch page: a "Buddy Room" pill appended to the actions row that holds
//      Like/Share/Save — a self-owned sibling, apricot and visually distinct
//      from YouTube's Save.
//   2. Any thumbnail: an "Add to Buddy Room" row appended to the tile's
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
	const FEEDBACK_MS = 2000;

	let currentVideoId = null;
	let playlistVideoIds = new Set(); // from ytb:room-data — powers "In Buddy Room"
	let hasRoomCode = false;
	let feedbackTimer = null;
	// The tile whose kebab was last clicked; consumed when its menu popup opens.
	let pendingKebab = null; // { videoId, title, at }

	injectStyle();

	function errorLabel(category) {
		if (category === 'playlist_full') return 'Playlist full';
		if (category === 'room_full') return 'Room full';
		return "Couldn't add";
	}

	async function addToPlaylist(videoId, title) {
		const clientId = await YTB.ensureClientId();
		const { name } = await YTB.getConfig();
		if (!YTB.isContextActive()) return { ok: false, category: 'unexpected' };
		const result = await YTB.postPlaylistAdd({ clientId, name, videoId, title });
		if (result.ok) playlistVideoIds.add(videoId);
		return result;
	}

	// ---------------------------------------------------------------------------
	// Watch page: the "Buddy Room" pill in the actions row.
	// ---------------------------------------------------------------------------

	function watchTitle() {
		const heading = document.querySelector('ytd-watch-metadata h1');
		const text = heading && heading.textContent ? heading.textContent.trim() : '';
		return text || document.title.replace(/ - YouTube$/, '').trim();
	}

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
				if (button.dataset.ytbState !== 'idle') return;
				const videoId = currentVideoId;
				setButtonState(button, 'busy');
				const result = await addToPlaylist(videoId, watchTitle());
				if (!button.isConnected) return;
				if (result.ok) {
					syncWatchButton(button);
				} else {
					flashButton(button, errorLabel(result.category));
				}
			});
		}
		if (button.parentElement !== actions) actions.appendChild(button);
		if (!feedbackTimer) syncWatchButton(button);
	}

	function setButtonState(button, state, label) {
		button.dataset.ytbState = state;
		button.textContent = label || (state === 'busy' ? 'Adding...' : state === 'added' ? 'In Buddy Room' : '+ Buddy Room');
		button.disabled = state === 'busy';
		button.classList.toggle('is-added', state === 'added');
	}

	function syncWatchButton(button) {
		setButtonState(button, playlistVideoIds.has(currentVideoId) ? 'added' : 'idle');
	}

	function flashButton(button, label) {
		setButtonState(button, 'error', label);
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = setTimeout(() => {
			feedbackTimer = null;
			if (button.isConnected) syncWatchButton(button);
		}, FEEDBACK_MS);
	}

	// ---------------------------------------------------------------------------
	// Thumbnails: the "Add to Buddy Room" row in a tile's three-dots menu.
	//
	// Flow: a capture-phase click listener notices a click inside a tile's
	// ytd-menu-renderer (the kebab) and remembers that tile's videoId + title;
	// the menu popup itself is rendered later into a top-level
	// tp-yt-iron-dropdown, so the next ytb:mutation injects our row into the
	// open listbox and consumes the pending capture.
	// ---------------------------------------------------------------------------

	const TILE_SELECTOR = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model';

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
			const titleEl = tile.querySelector('#video-title, .yt-lockup-metadata-view-model-wiz__title, a[title]');
			const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '';
			pendingKebab = { videoId, title: title.trim() || 'Untitled video', at: Date.now() };
		},
		true,
	);

	function injectKebabItem() {
		if (!pendingKebab || !hasRoomCode) return;
		// A stale capture (no menu ever opened) expires quietly.
		if (Date.now() - pendingKebab.at > 3000) {
			pendingKebab = null;
			return;
		}
		const dropdown = document.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"]) ytd-menu-popup-renderer');
		if (!dropdown) return; // menu not open (yet) — keep the capture until it expires
		const listbox = dropdown.querySelector('tp-yt-paper-listbox') || dropdown;
		if (listbox.querySelector('.' + KEBAB_ITEM_CLASS)) return;

		const { videoId, title } = pendingKebab;
		pendingKebab = null;

		const item = document.createElement('div');
		item.className = KEBAB_ITEM_CLASS;
		item.setAttribute('role', 'menuitem');
		item.tabIndex = 0;
		const icon = document.createElement('span');
		icon.className = 'ytb-kebab-add-icon';
		icon.textContent = '+';
		const label = document.createElement('span');
		label.textContent = 'Add to Buddy Room';
		item.append(icon, label);

		const activate = async () => {
			label.textContent = 'Adding...';
			const result = await addToPlaylist(videoId, title);
			label.textContent = result.ok ? 'Added to Buddy Room' : errorLabel(result.category);
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
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer, registered synchronously.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', async (event) => {
		if (!YTB.isContextActive()) return;
		currentVideoId = (event.detail && event.detail.videoId) || null;
		pendingKebab = null;
		const { code } = await YTB.getConfig();
		hasRoomCode = Boolean(code);
		ensureWatchButton();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		ensureWatchButton();
		injectKebabItem();
	});

	document.addEventListener('ytb:room-data', (event) => {
		if (!YTB.isContextActive()) return;
		const detail = (event && event.detail) || {};
		hasRoomCode = Boolean(detail.roomCode);
		playlistVideoIds = new Set((detail.playlist || []).map((item) => item.videoId));
		const button = document.getElementById(BUTTON_ID);
		if (button && !feedbackTimer) syncWatchButton(button);
		if (!hasRoomCode) document.getElementById(BUTTON_ID)?.remove();
	});

	YTB.onContextInvalidated(() => {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = null;
		document.getElementById(BUTTON_ID)?.remove();
		for (const item of document.querySelectorAll('.' + KEBAB_ITEM_CLASS)) item.remove();
	});

	/** Inject the styles once: apricot pill + menu row, quirky on purpose. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${BUTTON_ID} {
        margin-left: 8px;
        padding: 0 15px;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: #f6a96b;
        color: #3a2e28;
        font: 500 14px/36px Nunito, ui-rounded, Roboto, Arial, sans-serif;
        cursor: pointer;
        white-space: nowrap;
        transition: transform 140ms cubic-bezier(0.34, 1.3, 0.64, 1), background 140ms;
      }
      #${BUTTON_ID}:hover { background: #e88b45; }
      #${BUTTON_ID}:active { transform: scale(0.97); }
      #${BUTTON_ID}:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(246, 169, 107, 0.55); }
      #${BUTTON_ID}.is-added { background: transparent; border: 1px solid #f6a96b; color: #f6a96b; cursor: default; line-height: 34px; }
      #${BUTTON_ID}:disabled { opacity: 0.7; cursor: default; }
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
