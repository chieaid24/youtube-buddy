// The two Recommend Controls (grid renders in home-section.js; ADR-0007, CONTEXT.md "Recommend Control"): the watch-page pill
// (optimistic Recommend Intent; toggles idle/"Unrecommend") and the thumbnail kebab-menu row (DOM fragility deliberately accepted, issue #56/ADR-0005).
// Pure consumer per ADR-0001; enabled only with a Room Code set, and adding is NOT gated by Sharing.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-playlist-add-button';
	const KEBAB_ITEM_CLASS = 'ytb-kebab-add';
	const STYLE_ID = 'ytb-playlist-add-style';
	const FEEDBACK_ID = 'ytb-playlist-feedback';
	const FEEDBACK_MS = 2000;
	// Invisible per-video click cooldown (CONTEXT.md "Recommend Intent"): clicks within this window are silently ignored, no visual lockout.
	const CLICK_COOLDOWN_MS = 1000;
	// Recommend Celebration (CONTEXT.md): purely cosmetic "Recommended!" + confetti beat on idle -> recommend, then crossfades to "Unrecommend".
	const CELEBRATION_MS = 1200;
	const CELEBRATION_LABEL = 'Recommended!';
	const CONFETTI_COUNT = 14;
	const CONFETTI_COLORS = ['--ytb-accent-500', '--ytb-accent-600', '--ytb-accent-800'];

	let currentVideoId = null;
	// videoId -> recommending member's clientId (addedBy), from ok ytb:room-data reads. A failed read never rewrites it — emptiness is not truth.
	let recommenderByVideoId = new Map();
	// videoId -> { intent: 'mine'|'absent', title }: not-yet-confirmed Recommend Intents, overlaid on every Room read so a racing read can't flip the pill back.
	const recommendIntents = new Map();
	// videoId -> epoch ms of the last accepted pill click (the cooldown gate).
	let lastPillClickAt = new Map();
	// videoIds with a playlist write in flight — at most one per video; a mid-flight toggle goes out as a single delta once the write settles.
	const writesInFlight = new Set();
	let activeRoomCode = null; // a Room change orphans the old Room's intents
	let myClientId = null;
	let hasRoomCode = false;
	let feedbackTimer = null;
	let pendingKebab = null; // { videoId, title, at } of the last-clicked kebab, consumed when its menu popup opens
	let celebration = null; // { videoId, timer, confetti } of the live Recommend Celebration, or null

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
		// Server record is authoritative: re-recommending a Buddy's item is a no-op that returns THEIR item, so the pill must not claim it as ours.
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
		// Row holding Like/Share/Save; pill stays here even when Save hides under "..." overflow (accepted open tuning point).
		const actions = document.querySelector('ytd-watch-metadata #actions #top-level-buttons-computed');
		if (!actions) return; // metadata not built yet — a later ytb:mutation retries

		let button = document.getElementById(BUTTON_ID);
		if (!button) {
			button = document.createElement('button');
			button.id = BUTTON_ID;
			button.type = 'button';
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				const state = button.dataset.ytbState;
				const videoId = currentVideoId;
				if (!videoId || (state !== 'idle' && state !== 'recommended')) return;
				const now = Date.now();
				if (now - (lastPillClickAt.get(videoId) || 0) < CLICK_COOLDOWN_MS) return; // silent — no visual lockout
				lastPillClickAt.set(videoId, now);
				// Optimistic: flip the pill NOW, write goes out underneath (ADR-0007 un-recommend is the author-only point delete).
				recommendIntents.set(videoId, { intent: state === 'idle' ? 'mine' : 'absent', title: YTB.watchTitle(document) });
				if (state === 'idle') startCelebration(button, videoId); // only idle -> recommend celebrates (CONTEXT.md "Recommend Celebration")
				syncWatchButton(button);
				pumpWrites(videoId);
			});
		}
		if (button.parentElement !== actions) actions.appendChild(button);
		syncWatchButton(button);
	}

	const STATE_LABELS = {
		idle: 'Recommend to Buddies',
		added: 'Recommended to you', // a Buddy's Recommendation — nothing to toggle
		recommended: 'Unrecommend', // mine — the action offered, click to un-recommend
	};

	// Pill text lives in its own span so the Recommend Celebration can crossfade the label without touching the button's own opacity.
	function pillLabel(button) {
		let label = button.querySelector('.ytb-pill-label');
		if (!label) {
			label = document.createElement('span');
			label.className = 'ytb-pill-label';
			button.appendChild(label);
		}
		return label;
	}

	function setButtonState(button, state, celebrating) {
		button.dataset.ytbState = state;
		pillLabel(button).textContent = celebrating ? CELEBRATION_LABEL : STATE_LABELS[state] || STATE_LABELS.idle;
		button.classList.toggle('is-added', state === 'added');
		button.classList.toggle('is-recommended', state === 'recommended');
		button.classList.toggle('is-celebrating', Boolean(celebrating));
		button.title = state === 'recommended' && !celebrating ? 'You recommended this to your Buddies. Click to remove it for everyone.' : '';
	}

	function pillState() {
		const held = recommendIntents.get(currentVideoId);
		return YTB.recommendPillState({
			addedBy: recommenderByVideoId.get(currentVideoId),
			myClientId,
			pending: held && held.intent,
		});
	}

	function syncWatchButton(button) {
		const state = pillState();
		// Celebration overlays the mine-state ONLY; any exit from 'recommended' cuts it cleanly here.
		const celebrating = Boolean(celebration) && celebration.videoId === currentVideoId && state === 'recommended';
		if (celebration && !celebrating) endCelebration();
		setButtonState(button, state, celebrating);
	}

	// --- Recommend Celebration (CONTEXT.md): purely cosmetic overlay on the local idle -> recommend click; the optimistic flip happens regardless. ---

	function prefersReducedMotion() {
		return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	}

	function startCelebration(button, videoId) {
		endCelebration(); // a fresh click supersedes any running beat
		const c = { videoId, timer: null, confetti: null };
		celebration = c;
		if (!prefersReducedMotion()) c.confetti = spawnConfetti(button);
		c.timer = setTimeout(() => crossfadeToResting(button, c), CELEBRATION_MS);
	}

	function endCelebration() {
		if (!celebration) return;
		clearTimeout(celebration.timer);
		removeConfetti(celebration);
		celebration = null;
	}

	// End of the beat: fade "Recommended!" out, swap to resting "Unrecommend", fade back in. Reduced motion (or no WAAPI) swaps instantly.
	function crossfadeToResting(button, c) {
		if (celebration !== c) return; // superseded or already cut
		removeConfetti(c);
		const finish = () => {
			if (celebration === c) celebration = null;
			const b = document.getElementById(BUTTON_ID);
			if (b) syncWatchButton(b);
		};
		const label = button && button.isConnected && button.querySelector('.ytb-pill-label');
		if (!label || prefersReducedMotion() || typeof label.animate !== 'function') {
			finish();
			return;
		}
		label
			.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease' })
			.finished.then(() => {
				finish();
				if (label.isConnected) label.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease' });
			})
			.catch(() => finish()); // a cancelled fade still lands on the resting label
	}

	// One-shot apricot burst from the pill: fixed-positioned at its centre, pointer-events none, transform/opacity only, self-removing.
	function spawnConfetti(button) {
		const rect = button.getBoundingClientRect();
		const box = document.createElement('div');
		box.className = 'ytb-recommend-confetti';
		box.style.left = rect.left + rect.width / 2 + 'px';
		box.style.top = rect.top + rect.height / 2 + 'px';
		for (let i = 0; i < CONFETTI_COUNT; i++) {
			const p = document.createElement('span');
			const angle = (i / CONFETTI_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
			const dist = 28 + Math.random() * 30;
			p.style.setProperty('--ytb-cf-dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
			p.style.setProperty('--ytb-cf-dy', (Math.sin(angle) * dist - 12).toFixed(1) + 'px');
			p.style.setProperty('--ytb-cf-rot', Math.round(Math.random() * 540 - 270) + 'deg');
			p.style.background = 'var(' + CONFETTI_COLORS[i % CONFETTI_COLORS.length] + ', #f6a96b)';
			p.style.animationDuration = Math.round(720 + Math.random() * 260) + 'ms';
			box.appendChild(p);
		}
		(document.body || document.documentElement).appendChild(box);
		return { box, timer: setTimeout(() => box.remove(), 1100) };
	}

	function removeConfetti(c) {
		if (!c || !c.confetti) return;
		clearTimeout(c.confetti.timer);
		c.confetti.box.remove();
		c.confetti = null;
	}

	// Drive one video's pending Recommend Intent to the backend: at most one write in flight per videoId, re-examined when it settles so a
	// mid-flight toggle goes out as a single delta. A failed write drops the intent (pill reverts) and puts the reason in the feedback popover.
	async function pumpWrites(videoId) {
		if (writesInFlight.has(videoId)) return;
		const held = recommendIntents.get(videoId);
		if (!held) return;
		const addedBy = recommenderByVideoId.get(videoId);
		// Confirmed state already matches (a prior write landed): nothing to send; the intent stays held until an ok Room read agrees.
		if (held.intent === 'mine' ? addedBy !== undefined : addedBy === undefined) return;
		writesInFlight.add(videoId);
		let result;
		if (held.intent === 'mine') {
			result = await addToPlaylist(videoId, held.title);
		} else {
			const clientId = await YTB.ensureClientId();
			result = YTB.isContextActive() ? await YTB.deletePlaylistItem({ clientId, videoId }) : { ok: false, category: 'unexpected' };
			if (result.ok) recommenderByVideoId.delete(videoId);
		}
		writesInFlight.delete(videoId);
		if (!YTB.isContextActive()) return;
		if (result.ok) {
			// The intent may have moved while this write flew; send the delta.
			pumpWrites(videoId);
		} else {
			// Revert: dropping the intent leaves the true state as-is, which also honors a mid-flight toggle back to the pre-write state.
			recommendIntents.delete(videoId);
			showWriteFailure(videoId, held.intent, result.category);
		}
		const button = document.getElementById(BUTTON_ID);
		if (button) syncWatchButton(button);
	}

	function showWriteFailure(videoId, intent, category) {
		if (videoId !== currentVideoId) return; // navigated away — the revert lands silently
		const button = document.getElementById(BUTTON_ID);
		if (!button) return;
		const message = intent === 'absent' && category !== 'network' ? "Couldn't unrecommend" : errorLabel(category);
		showFeedback(button, message);
	}

	// Transient feedback popover — the ONLY failure surface the pill owns; the label itself is a state, never a message.
	function showFeedback(button, message) {
		document.getElementById(FEEDBACK_ID)?.remove();
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
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = setTimeout(() => {
			feedbackTimer = null;
			document.getElementById(FEEDBACK_ID)?.remove();
			if (button.isConnected) button.removeAttribute('aria-describedby');
		}, FEEDBACK_MS);
	}

	// ---------------------------------------------------------------------------
	// Thumbnails: the "Recommend to Buddies" row in a tile's three-dots menu.
	//
	// Flow: a capture-phase click on a tile's kebab records its videoId + title;
	// the menu popup renders later into a top-level tp-yt-iron-dropdown, so the
	// next ytb:mutation injects our row into the open menu and consumes the capture.
	//
	// Two live menu generations (verified against real YouTube markup):
	//   - classic tiles: tp-yt-iron-dropdown > ytd-menu-popup-renderer > tp-yt-paper-listbox
	//   - lockup tiles (yt-lockup-view-model): tp-yt-iron-dropdown > yt-sheet-view-model
	//       > yt-contextual-sheet-layout > yt-list-view-model[role="menu"]
	// YouTube reuses ONE dropdown node for successive popups, so an injected row must
	// never outlive its menu (removed when closed; a fresh capture replaces stale rows).
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
			// The kebab: a ytd-menu-renderer (classic tiles) or an options/more button (lockup tiles).
			const trigger = target && (target.closest('ytd-menu-renderer') || target.closest('yt-icon-button, button'));
			if (!trigger) return;
			const tile = trigger.closest(TILE_SELECTOR);
			if (!tile || tile.closest('#ytb-home-section')) return;
			const anchor = tile.querySelector('a[href*="/watch?v="]');
			const videoId = anchor && videoIdFromHref(anchor.getAttribute('href'));
			if (!videoId) return;
			// Lockup tiles: .ytLockupMetadataViewModelTitle (-wiz__ kept for stragglers); classic tiles: #video-title; else a[title] fallback.
			const titleEl =
				tile.querySelector('#video-title, .ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model-wiz__title') ||
				tile.querySelector('a[title]');
			const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '';
			pendingKebab = { videoId, title: title.trim() || 'Untitled video', at: Date.now() };
		},
		true,
	);

	// The list element of the currently open tile menu, across both menu generations, or null while no menu is open.
	function openMenuList() {
		for (const dropdown of document.querySelectorAll('tp-yt-iron-dropdown:not([aria-hidden="true"])')) {
			if (dropdown.style.display === 'none') continue; // closed but not yet re-hidden
			const popup = dropdown.querySelector('ytd-menu-popup-renderer'); // classic tiles
			if (popup) return popup.querySelector('tp-yt-paper-listbox') || popup;
			const sheet = dropdown.querySelector('yt-sheet-view-model'); // lockup tiles
			if (sheet) return sheet.querySelector('yt-list-view-model') || sheet;
		}
		return null;
	}

	function syncKebabMenu() {
		// A row must never outlive its menu: YouTube reuses one dropdown node per popup, so a survivor could resurface under the wrong menu.
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

	// The popup must show the new row without scrolling: YouTube sized it before the row existed, so grow any inline max-height by the
	// row's height and let the dropdown refit itself in case the taller menu would overflow the viewport.
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
		endCelebration(); // navigating away mid-beat cleans up
		currentVideoId = (event.detail && event.detail.videoId) || null;
		pendingKebab = null;
		lastPillClickAt = new Map(); // the click cooldown resets on navigation
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
		if (detail.roomCode !== activeRoomCode) {
			// A Room change orphans the previous Room's optimistic state.
			activeRoomCode = detail.roomCode;
			recommendIntents.clear();
			lastPillClickAt = new Map();
		}
		if (detail.ok) {
			recommenderByVideoId = new Map((detail.playlist || []).map((item) => [item.videoId, item.addedBy]));
			// Drop each Recommend Intent this read agrees with; the rest keep overlaying.
			for (const [videoId, held] of recommendIntents) {
				if (YTB.recommendIntentSettled({ addedBy: recommenderByVideoId.get(videoId), myClientId, pending: held.intent })) {
					recommendIntents.delete(videoId);
				}
			}
		} else if (detail.locked) {
			// Locked out of a full Room: nothing of ours can be on the list.
			recommenderByVideoId = new Map();
			recommendIntents.clear();
		}
		// A plain failed read (ok: false) rewrites nothing — emptiness is not truth.
		const button = document.getElementById(BUTTON_ID);
		if (button) syncWatchButton(button);
		if (!hasRoomCode) document.getElementById(BUTTON_ID)?.remove();
	});

	YTB.onContextInvalidated(() => {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = null;
		endCelebration();
		document.getElementById(FEEDBACK_ID)?.remove();
		document.getElementById(BUTTON_ID)?.remove();
		for (const item of document.querySelectorAll('.' + KEBAB_ITEM_CLASS)) item.remove();
	});

	// Inject the styles once: apricot pill + menu row, quirky on purpose.
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* Shared --ytb-* tokens like every sibling YTB surface (UA-010); transparent border keeps the label inset identical across states. */
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
      /* Outline states use accent-800 text: raw apricot fill misses AA on the page (1.94:1), and accent-800 flips bright on dark theme (UA-002). */
      #${BUTTON_ID}.is-added { background: transparent; border: 1px solid var(--ytb-accent-800, #9e551f); color: var(--ytb-accent-800, #9e551f); cursor: default; line-height: 34px; }
      #${BUTTON_ID}.is-recommended { background: transparent; border: 1px solid var(--ytb-accent-800, #9e551f); color: var(--ytb-accent-800, #9e551f); line-height: 34px; }
      #${BUTTON_ID}.is-recommended:hover { background: rgba(246, 169, 107, 0.14); }
      #${BUTTON_ID} .ytb-pill-label { display: inline-block; }
      /* :hover variant is load-bearing: .is-recommended:hover otherwise outranks single-class .is-celebrating and hides the celebration label. */
      #${BUTTON_ID}.is-celebrating,
      #${BUTTON_ID}.is-celebrating:hover { background: var(--ytb-accent-500, #f6a96b); border-color: transparent; color: var(--ytb-on-accent, #3a2e28); }
      /* Apricot burst: fixed, non-interactive, transform/opacity only, tinted from --ytb-* tokens, removed when the beat ends. */
      .ytb-recommend-confetti { position: fixed; z-index: 2147483646; width: 0; height: 0; pointer-events: none; }
      .ytb-recommend-confetti > span {
        position: absolute;
        left: 0;
        top: 0;
        width: 8px;
        height: 8px;
        margin: -4px 0 0 -4px;
        border-radius: 2px;
        pointer-events: none;
        will-change: transform, opacity;
        animation-name: ytb-recommend-confetti-pop;
        animation-timing-function: cubic-bezier(0.22, 0.7, 0.3, 1);
        animation-fill-mode: forwards;
      }
      @keyframes ytb-recommend-confetti-pop {
        0% { transform: translate(0, 0) scale(0.3) rotate(0deg); opacity: 1; }
        70% { opacity: 1; }
        100% { transform: translate(var(--ytb-cf-dx, 0), var(--ytb-cf-dy, -30px)) scale(1) rotate(var(--ytb-cf-rot, 180deg)); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) { .ytb-recommend-confetti { display: none; } }
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
