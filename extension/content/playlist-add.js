// Both Recommend Controls (ADR-0007): the watch-page Recommend strip the Note Composer mounts (optimistic Recommend Intent) and the
// thumbnail kebab-menu row (YouTube-menu DOM fragility deliberately accepted, #56/ADR-0005); the grid renders in home-section.js.
// Pure consumer per ADR-0001; needs a Room Code; adding is NOT gated by Notes Visibility.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-playlist-add-button';
	const STRIP_CLASS = 'ytb-recommend-strip';
	const KEBAB_ITEM_CLASS = 'ytb-kebab-add';
	const STYLE_ID = 'ytb-playlist-add-style';
	const FEEDBACK_ID = 'ytb-playlist-feedback';
	const FEEDBACK_MS = 2000;
	// Invisible per-video click cooldown (CONTEXT.md "Recommend Intent"): silent, never a visual lockout.
	const CLICK_COOLDOWN_MS = 1000;
	// Recommend Celebration (CONTEXT.md): cosmetic confetti beat on idle -> recommend, then crossfades to "Unrecommend".
	const CELEBRATION_MS = 1200;
	const CELEBRATION_LABEL = 'Recommended!';
	const CONFETTI_COUNT = 14;
	const CONFETTI_COLORS = ['--ytb-accent-500', '--ytb-accent-600', '--ytb-accent-800'];

	let currentVideoId = null;
	// videoId -> addedBy clientId, from ok ytb:room-data reads; a failed read never rewrites it -- emptiness is not truth.
	let recommenderByVideoId = new Map();
	// videoId -> { intent: 'mine'|'absent', title, channel }: not-yet-confirmed Recommend Intents, overlaid on every Room read so a racing read can't flip the strip back.
	const recommendIntents = new Map();
	// videoId -> epoch ms of the last accepted strip click (the cooldown gate).
	let lastClickAt = new Map();
	// at most one write in flight per video; a mid-flight toggle goes out as one delta once it settles.
	const writesInFlight = new Set();
	let activeRoomCode = null; // a Room change orphans the old Room's intents
	let myClientId = null;
	let hasRoomCode = false;
	let feedbackTimer = null;
	let pendingKebab = null; // { videoId, title, channel, at } of the last-clicked kebab, consumed when its menu popup opens
	let celebration = null; // { videoId, timer, confetti } of the live Recommend Celebration, or null

	injectStyle();

	function errorLabel(category) {
		if (category === 'network') return YTB.errorCopy(category, 'recommendation');
		if (category === 'playlist_full') return 'Room list full';
		if (category === 'room_full') return 'Room full';
		return "Couldn't add";
	}

	async function addToPlaylist(videoId, title, channel) {
		const clientId = await YTB.ensureClientId();
		const { name } = await YTB.getConfig();
		if (!YTB.isContextActive()) return { ok: false, category: 'unexpected' };
		myClientId = myClientId || clientId;
		const result = await YTB.postPlaylistAdd({ clientId, name, videoId, title, channel });
		// Re-recommending a Buddy's item is a no-op returning THEIR item; the strip must not claim it as ours.
		if (result.ok) recommenderByVideoId.set(videoId, (result.item && result.item.addedBy) || clientId);
		return result;
	}

	// --- Watch page: the Recommend strip at the foot of the Note Composer (composer.js mounts it via YTBRecommend). ---

	const STATE_LABELS = {
		idle: 'Recommend to Buddies',
		recommended: 'Unrecommend', // mine - the action offered beside the status
	};
	const STATE_STATUS = {
		added: 'Recommended to you', // a Buddy's Recommendation - nothing to toggle
		recommended: 'You recommended this',
	};

	function mountedStrip() {
		return document.querySelector('.' + STRIP_CLASS);
	}

	function buildStrip() {
		const strip = document.createElement('div');
		strip.className = STRIP_CLASS;
		const status = document.createElement('span');
		status.className = 'ytb-recommend-status';
		const button = document.createElement('button');
		button.id = BUTTON_ID;
		button.type = 'button';
		// Own span so the celebration swaps the label without rebuilding the button.
		const label = document.createElement('span');
		label.className = 'ytb-recommend-label';
		button.append(label);
		button.addEventListener('click', () => {
			const state = button.dataset.ytbState;
			const videoId = currentVideoId;
			if (!videoId || (state !== 'idle' && state !== 'recommended')) return;
			const now = Date.now();
			if (now - (lastClickAt.get(videoId) || 0) < CLICK_COOLDOWN_MS) return; // silent - no visual lockout
			lastClickAt.set(videoId, now);
			// Optimistic: flip the strip NOW, write goes out underneath (ADR-0007 un-recommend is the author-only point delete).
			recommendIntents.set(videoId, {
				intent: state === 'idle' ? 'mine' : 'absent',
				title: YTB.watchTitle(document),
				channel: YTB.watchChannel(document),
			});
			// Only idle -> recommend celebrates (CONTEXT.md "Recommend Celebration").
			if (state === 'idle') startCelebration(strip, videoId);
			else syncStrip(strip);
			pumpWrites(videoId);
		});
		strip.append(status, button);
		syncStrip(strip);
		return strip;
	}

	function setStripState(strip, state, celebrating) {
		const button = strip.querySelector('#' + BUTTON_ID);
		button.dataset.ytbState = state;
		button.querySelector('.ytb-recommend-label').textContent = celebrating ? CELEBRATION_LABEL : STATE_LABELS[state] || '';
		button.hidden = state === 'added';
		button.title = state === 'recommended' && !celebrating ? 'You recommended this to your Buddies. Click to remove it for everyone.' : '';
		const status = strip.querySelector('.ytb-recommend-status');
		const statusText = celebrating ? '' : STATE_STATUS[state] || '';
		status.replaceChildren();
		if (statusText) {
			if (state === 'recommended') status.append(YTBTheme.icon('check'));
			status.append(statusText);
		}
		strip.classList.toggle('is-added', state === 'added');
		strip.classList.toggle('is-recommended', state === 'recommended');
		strip.classList.toggle('is-celebrating', Boolean(celebrating));
	}

	function controlState() {
		const held = recommendIntents.get(currentVideoId);
		return YTB.recommendControlState({
			addedBy: recommenderByVideoId.get(currentVideoId),
			myClientId,
			pending: held && held.intent,
		});
	}

	function syncStrip(strip) {
		const state = controlState();
		// Celebration overlays the mine-state ONLY; any exit from 'recommended' cuts it cleanly here.
		const celebrating = Boolean(celebration) && celebration.videoId === currentVideoId && state === 'recommended';
		if (celebration && !celebrating) endCelebration();
		setStripState(strip, state, celebrating);
	}

	// --- Recommend Celebration (CONTEXT.md): purely cosmetic overlay on the local idle -> recommend click; the optimistic flip happens regardless. ---

	function prefersReducedMotion() {
		return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	}

	function startCelebration(strip, videoId) {
		endCelebration(); // a fresh click supersedes any running beat
		const c = { videoId, timer: null, confetti: null };
		celebration = c;
		syncStrip(strip); // the burst centres on the celebrating label, so that renders first
		if (celebration !== c) return;
		if (!prefersReducedMotion()) c.confetti = spawnConfetti(strip);
		c.timer = setTimeout(() => crossfadeToResting(c), CELEBRATION_MS);
	}

	function endCelebration() {
		if (!celebration) return;
		clearTimeout(celebration.timer);
		removeConfetti(celebration);
		celebration = null;
	}

	// End of the beat: fade the celebrating fill out, swap to the resting status + "Unrecommend", fade back in. Reduced motion (or no WAAPI) swaps instantly.
	function crossfadeToResting(c) {
		if (celebration !== c) return; // superseded or already cut
		removeConfetti(c);
		const finish = () => {
			if (celebration === c) celebration = null;
			const s = mountedStrip();
			if (s) syncStrip(s);
		};
		const strip = mountedStrip();
		const button = strip && strip.querySelector('#' + BUTTON_ID);
		if (!button || prefersReducedMotion() || typeof button.animate !== 'function') {
			finish();
			return;
		}
		button
			.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease' })
			.finished.then(() => {
				finish();
				if (!strip.isConnected) return;
				for (const el of [strip.querySelector('.ytb-recommend-status'), button]) {
					el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease' });
				}
			})
			.catch(() => finish()); // a cancelled fade still lands on the resting state
	}

	// One-shot apricot burst from the celebrating label: inside the strip so it survives fullscreen, pointer-events none, transform/opacity only, self-removing.
	function spawnConfetti(strip) {
		const origin = strip.getBoundingClientRect();
		const rect = strip.querySelector('.ytb-recommend-label').getBoundingClientRect();
		const box = document.createElement('div');
		box.className = 'ytb-recommend-confetti';
		box.style.left = rect.left - origin.left + rect.width / 2 + 'px';
		box.style.top = rect.top - origin.top + rect.height / 2 + 'px';
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
		strip.appendChild(box);
		return { box, timer: setTimeout(() => box.remove(), 1100) };
	}

	function removeConfetti(c) {
		if (!c || !c.confetti) return;
		clearTimeout(c.confetti.timer);
		c.confetti.box.remove();
		c.confetti = null;
	}

	// Drive one video's pending Recommend Intent to the backend: at most one write in flight per videoId, re-examined when it settles so a
	// mid-flight toggle goes out as a single delta. A failed write drops the intent (strip reverts) and puts the reason in the feedback line.
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
			result = await addToPlaylist(videoId, held.title, held.channel);
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
		const strip = mountedStrip();
		if (strip) syncStrip(strip);
	}

	function showWriteFailure(videoId, intent, category) {
		if (videoId !== currentVideoId) return; // navigated away - the revert lands silently
		const strip = mountedStrip();
		if (!strip) return; // composer closed - likewise silent
		const message = intent === 'absent' && category !== 'network' ? "Couldn't unrecommend" : errorLabel(category);
		showFeedback(strip, message);
	}

	// Transient feedback line over the strip - the ONLY failure surface the control owns; the label itself is a state, never a message.
	function showFeedback(strip, message) {
		document.getElementById(FEEDBACK_ID)?.remove();
		const button = strip.querySelector('#' + BUTTON_ID);
		const feedback = document.createElement('span');
		feedback.id = FEEDBACK_ID;
		feedback.setAttribute('role', 'status');
		feedback.textContent = message;
		strip.append(feedback);
		button.setAttribute('aria-describedby', FEEDBACK_ID);
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = setTimeout(() => {
			feedbackTimer = null;
			feedback.remove();
			button.removeAttribute('aria-describedby');
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
			pendingKebab = { videoId, title: title.trim() || 'Untitled video', channel: YTB.tileChannel(tile, document), at: Date.now() };
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
		if (!listbox) return; // menu not open (yet) - keep the capture until it expires

		const { videoId, title, channel } = pendingKebab;
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
			const result = await addToPlaylist(videoId, title, channel);
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
		endCelebration(); // navigating away mid-beat cleans up
		currentVideoId = (event.detail && event.detail.videoId) || null;
		pendingKebab = null;
		lastClickAt = new Map(); // the click cooldown resets on navigation
		const { code } = await YTB.getConfig();
		hasRoomCode = Boolean(code);
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
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
			lastClickAt = new Map();
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
		// A plain failed read (ok: false) rewrites nothing - emptiness is not truth.
		const strip = mountedStrip();
		if (strip) syncStrip(strip);
	});

	YTB.onContextInvalidated(() => {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = null;
		endCelebration();
		for (const item of document.querySelectorAll('.' + KEBAB_ITEM_CLASS)) item.remove();
	});

	// Inject the styles once: the Recommend strip + the apricot menu row.
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* Footer band of the Note Composer (composer.js owns the bleed); shared --ytb-* tokens like every sibling YTB surface (UA-010). */
      .${STRIP_CLASS} {
        position: relative;
        display: flex;
        align-items: center;
        min-height: 40px;
        border-top: 1px solid var(--ytb-line);
        border-radius: 0 0 calc(var(--ytb-r-lg) - 1px) calc(var(--ytb-r-lg) - 1px);
      }
      .${STRIP_CLASS} .ytb-recommend-status {
        flex: 1 1 auto;
        min-width: 0;
        padding-left: 16px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ytb-ink-muted);
        font: 600 13px/1.3 var(--ytb-font);
      }
      .${STRIP_CLASS} .ytb-recommend-status:empty { display: none; }
      .${STRIP_CLASS} .ytb-recommend-status svg { width: 14px; height: 14px; margin-right: 4px; vertical-align: -2px; color: var(--ytb-accent-800); }
      /* Idle: the whole band is the button. */
      #${BUTTON_ID} {
        flex: 1 1 auto;
        align-self: stretch;
        padding: 0 16px;
        border: 0;
        border-radius: inherit;
        background: transparent;
        color: var(--ytb-accent-800);
        font: 700 13px/1.3 var(--ytb-font);
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
        transition:
          background var(--ytb-dur-quick) var(--ytb-ease-out),
          color var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${BUTTON_ID}[hidden] { display: none; }
      #${BUTTON_ID}:hover { background: var(--ytb-accent-050); }
      #${BUTTON_ID}:focus-visible { outline: none; box-shadow: inset 0 0 0 3px var(--ytb-ring); }
      #${BUTTON_ID} .ytb-recommend-label { display: inline-block; transform-origin: left center; transition: transform var(--ytb-dur-quick) var(--ytb-ease-spring); }
      #${BUTTON_ID}:active .ytb-recommend-label { transform: scale(0.97); }
      /* Resting mine-state: status on the left, a compact "Unrecommend" action on the right. */
      .${STRIP_CLASS}.is-recommended:not(.is-celebrating) > #${BUTTON_ID} {
        flex: 0 0 auto;
        align-self: center;
        min-height: 24px;
        margin-right: 8px;
        padding: 4px 8px;
        border-radius: var(--ytb-r-pill);
        color: var(--ytb-ink-muted);
        font-weight: 600;
      }
      .${STRIP_CLASS}.is-recommended:not(.is-celebrating) > #${BUTTON_ID}:hover { color: var(--ytb-ink); }
      .${STRIP_CLASS}.is-recommended:not(.is-celebrating) > #${BUTTON_ID}:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      /* :hover variant is load-bearing: the click leaves the pointer on the band, and the hover wash must not replace the celebration fill. */
      .${STRIP_CLASS}.is-celebrating > #${BUTTON_ID},
      .${STRIP_CLASS}.is-celebrating > #${BUTTON_ID}:hover { background: var(--ytb-accent-500); color: var(--ytb-on-accent); }
      /* Apricot burst: non-interactive, transform/opacity only, tinted from --ytb-* tokens, removed when the beat ends. */
      .ytb-recommend-confetti { position: absolute; z-index: 1; width: 0; height: 0; pointer-events: none; }
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
      /* Covers the band (and its hairline) while a failure shows; grows upward if the copy wraps. */
      #${FEEDBACK_ID} {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        min-height: calc(100% + 1px);
        padding: 4px 16px;
        border-top: 1px solid var(--ytb-line);
        border-radius: inherit;
        background: var(--ytb-surface);
        color: var(--ytb-danger-text);
        font: 600 11px/1.35 var(--ytb-font);
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
        #${BUTTON_ID}, #${BUTTON_ID} .ytb-recommend-label { transition: none; }
        #${BUTTON_ID}:active .ytb-recommend-label { transform: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	window.YTBRecommend = { buildStrip };
})();
