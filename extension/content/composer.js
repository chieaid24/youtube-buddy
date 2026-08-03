// composer.js - the Add Note composer, attached to YouTube's player controls.
// Player-bound (lives inside #movie_player, clamped to it, survives fullscreen); opening pauses and closing/posting resumes only if it paused a playing video; every dismissal discards the draft silently. Styling uses theme.js's --ytb-* tokens, which also isolates textarea/checkbox keystrokes from YouTube's hotkeys.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-note-button';
	const COMPOSER_ID = 'ytb-note-composer';
	let currentVideoId = null;
	let openToken = 0;
	let pauseLeaseActive = false; // opening the composer paused a playing video
	let composerPressOrigin = 'elsewhere'; // capture-time origin for the next click (ADR-0011)
	// Hover-scoped Controls Hold (CONTEXT.md): held only while the pointer hovers the
	// panel, not on focus (auto-focus would pin the chrome for as long as it's open).
	let holdRelease = null;

	// Spoiler Default seeds the checkbox on each open; the + button is removed while
	// Notes Visibility is off or Unpaired (need a Room to read Notes, so to write them).
	let spoilerDefault = true;
	let notesHidden = false;
	let hasRoomCode = false; // Room membership gates the + button (Unpaired hides it)

	YTB.getSettings().then((settings) => {
		spoilerDefault = settings.spoilerDefault;
		notesHidden = settings.notesHidden;
		ensureButton();
	});

	YTB.getConfig().then(({ code }) => {
		hasRoomCode = Boolean(code);
		ensureButton();
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !YTB.isContextActive()) return;
		if (changes.spoilerDefault) spoilerDefault = changes.spoilerDefault.newValue !== false;
		if (changes.notesHidden) {
			notesHidden = changes.notesHidden.newValue === true;
			if (notesHidden) closeComposer(); // dismissal semantics: lease-aware resume
			ensureButton();
		}
		if (changes.code) {
			hasRoomCode = Boolean(changes.code.newValue);
			if (!hasRoomCode) closeComposer(); // leaving the Room dismisses an open composer
			ensureButton();
		}
	});

	// The Add Note BUTTON stays player-native white (it lives in YouTube's own
	// control bar, where an apricot chip would clash); the panel uses theme.js's tokens.
	function ensureStyles() {
		if (document.getElementById('ytb-composer-styles')) return;
		const style = document.createElement('style');
		style.id = 'ytb-composer-styles';
		style.textContent = `
      #${BUTTON_ID} { flex: 0 0 auto; width: 34px; height: 100%; margin: 0 2px; padding: 0; border: 0; background: transparent; color: #fff; cursor: pointer; opacity: .9; font: 700 18px/1 Arial,sans-serif; }
      #${BUTTON_ID}:hover, #${BUTTON_ID}:focus-visible { opacity: 1; background: rgba(255,255,255,.12); outline: none; }
      #${COMPOSER_ID} {
        position: absolute;
        z-index: 2100;
        box-sizing: border-box;
        padding: 16px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        box-shadow: var(--ytb-e-dialog);
        font: 13px/1.45 var(--ytb-font);
        text-align: left;
        animation: ytb-composer-in var(--ytb-dur-base) var(--ytb-ease-spring);
      }
      @keyframes ytb-composer-in {
        from { opacity: 0; transform: scale(0.96) translateY(4px); }
      }
      #${COMPOSER_ID} .ytb-note-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      #${COMPOSER_ID} .ytb-note-title { font-weight: 800; font-size: 15px; }
      #${COMPOSER_ID} .ytb-note-time { margin-left: auto; color: var(--ytb-ink-muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
      #${COMPOSER_ID} .ytb-note-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--ytb-ink-faint);
        cursor: pointer;
        transition:
          color var(--ytb-dur-quick) var(--ytb-ease-out),
          background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${COMPOSER_ID} .ytb-note-close:hover, #${COMPOSER_ID} .ytb-note-close:focus-visible { background: var(--ytb-accent-050); color: var(--ytb-ink); outline: none; }
      #${COMPOSER_ID} .ytb-note-close:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${COMPOSER_ID} .ytb-note-close svg { width: 14px; height: 14px; }
      #${COMPOSER_ID} .ytb-note-emojis { display: flex; gap: 8px; margin: 0 0 8px; }
      #${COMPOSER_ID} .ytb-note-emoji {
        flex: 1 1 0;
        height: 42px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface-tint);
        cursor: pointer;
        font-size: 22px;
        transition:
          background var(--ytb-dur-quick) var(--ytb-ease-out),
          border-color var(--ytb-dur-quick) var(--ytb-ease-out),
          transform var(--ytb-dur-quick) var(--ytb-ease-spring);
      }
      #${COMPOSER_ID} .ytb-note-emoji:hover, #${COMPOSER_ID} .ytb-note-emoji:focus-visible { border-color: var(--ytb-accent-500); background: var(--ytb-accent-100); outline: none; }
      #${COMPOSER_ID} .ytb-note-emoji:active { transform: scale(0.95); }
      #${COMPOSER_ID} .ytb-note-emoji:disabled { opacity: .5; cursor: default; }
      #${COMPOSER_ID} textarea {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 12px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: var(--ytb-r-sm);
        background: var(--ytb-surface-sunk);
        color: var(--ytb-ink);
        font: inherit;
        resize: none;
        overflow: hidden;
        transition:
          border-color var(--ytb-dur-quick) var(--ytb-ease-out),
          box-shadow var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${COMPOSER_ID} textarea::placeholder { color: var(--ytb-ink-faint); }
      #${COMPOSER_ID} textarea:focus { border-color: var(--ytb-accent-500); box-shadow: 0 0 0 3px var(--ytb-ring); outline: none; }
      #${COMPOSER_ID} .ytb-note-meta { height: 18px; margin-top: 4px; text-align: right; color: var(--ytb-ink-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      #${COMPOSER_ID} .ytb-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      /* min-height keeps the Spoiler label a 24px hit target (UA-006). */
      #${COMPOSER_ID} label { display: flex; align-items: center; gap: 4px; min-height: 24px; font-size: 13px; font-weight: 600; color: var(--ytb-ink-muted); }
      #${COMPOSER_ID} input[type='checkbox'] { accent-color: var(--ytb-accent-600); }
      #${COMPOSER_ID} .ytb-note-post {
        padding: 8px 16px;
        border: 0;
        border-radius: var(--ytb-r-pill);
        background: var(--ytb-accent-500);
        color: var(--ytb-on-accent);
        font: 700 13px/1.3 var(--ytb-font);
        cursor: pointer;
        transition:
          background var(--ytb-dur-quick) var(--ytb-ease-out),
          transform var(--ytb-dur-quick) var(--ytb-ease-spring);
      }
      #${COMPOSER_ID} .ytb-note-post:hover:not(:disabled) { background: var(--ytb-accent-600); }
      #${COMPOSER_ID} .ytb-note-post:active:not(:disabled) { transform: scale(0.97); }
      #${COMPOSER_ID} .ytb-note-post:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${COMPOSER_ID} .ytb-note-post:disabled { background: var(--ytb-surface-sunk); color: var(--ytb-ink-faint); cursor: default; }
      #${COMPOSER_ID} .ytb-note-error { min-height: 18px; margin-top: 8px; color: var(--ytb-danger-text); font-size: 11px; font-weight: 600; }
      @media (prefers-reduced-motion: reduce) {
        #${COMPOSER_ID} { animation: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	// Close and discard the draft; resumes playback only if opening paused it.
	// Pass resume: false on navigation, where the video is changing.
	function closeComposer({ resume = true } = {}) {
		openToken += 1;
		holdRelease?.(); // hand the autohide timer back to YouTube
		holdRelease = null;
		composerPressOrigin = 'elsewhere';
		document.getElementById(COMPOSER_ID)?.remove();
		if (resume && pauseLeaseActive) {
			const video = document.querySelector('video');
			if (video && video.paused) video.play();
		}
		pauseLeaseActive = false;
	}

	/** Clamp the composer above its button, fully inside the player. */
	function positionComposer(composer, button) {
		const host = document.querySelector('#movie_player');
		if (!host || !button.isConnected) return;
		const hostRect = host.getBoundingClientRect();
		const buttonRect = button.getBoundingClientRect();
		const width = Math.min(340, Math.max(240, hostRect.width - 24));
		composer.style.width = width + 'px';
		composer.style.left = Math.max(12, Math.min(buttonRect.left - hostRect.left, hostRect.width - width - 12)) + 'px';
		const bottom = Math.max(12, hostRect.bottom - buttonRect.top + 10);
		composer.style.bottom = Math.min(bottom, Math.max(12, hostRect.height - 40)) + 'px';
	}

	async function openComposer(button) {
		if (!YTB.isContextActive()) return;
		if (document.getElementById(COMPOSER_ID)) {
			closeComposer(); // the Add Note button toggles: dismiss + discard
			return;
		}
		const host = document.querySelector('#movie_player');
		const video = document.querySelector('video');
		if (!host || !video || !currentVideoId) return;

		// Capture the moment and pause in place, remembering whether we did.
		const timestamp = Math.max(0, Number(video.currentTime) || 0);
		pauseLeaseActive = false;
		if (!video.paused) {
			pauseLeaseActive = true;
			video.pause();
		}

		const token = ++openToken;
		const config = await YTB.getConfig();
		if (!YTB.isContextActive() || token !== openToken || !button.isConnected) return;

		const composer = document.createElement('section');
		composer.id = COMPOSER_ID;
		composer.setAttribute('role', 'dialog');
		composer.setAttribute('aria-label', 'Add a Note');

		const head = document.createElement('div');
		head.className = 'ytb-note-head';
		const title = document.createElement('span');
		title.className = 'ytb-note-title';
		title.textContent = 'Add a Note';
		const time = document.createElement('time');
		time.className = 'ytb-note-time';
		time.textContent = '@' + YTB.formatTime(timestamp);
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'ytb-note-close';
		close.append(YTBTheme.icon('close'));
		close.setAttribute('aria-label', 'Close without posting');
		close.addEventListener('click', () => closeComposer());
		head.append(title, time, close);
		composer.append(head);

		// Sharing does not gate Note writes (CONTEXT.md): the form always builds in a Room.
		buildForm(composer, config, timestamp);

		// Keep interactions inside the composer: no player seeks/pauses or outside-click dismissal.
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'click', 'dblclick']) {
			composer.addEventListener(type, (e) => e.stopPropagation());
		}

		host.append(composer);
		// Hover-scoped Controls Hold; closeComposer releases any hold still live on close.
		holdRelease = YTB.bindHoverHold(composer);
		positionComposer(composer, button);
		composer.querySelector('textarea')?.focus();
	}

	function buildForm(composer, config, timestamp) {
		let pending = false;
		const error = document.createElement('div');
		error.className = 'ytb-note-error';
		error.setAttribute('role', 'status');

		// One-click Reactions: clicking immediately submits (never a Spoiler), discarding any draft.
		const emojis = document.createElement('div');
		emojis.className = 'ytb-note-emojis';
		emojis.setAttribute('role', 'group');
		emojis.setAttribute('aria-label', 'Post a Reaction');
		for (const emoji of YTB.NOTE_EMOJIS) {
			const option = document.createElement('button');
			option.type = 'button';
			option.className = 'ytb-note-emoji';
			option.textContent = emoji;
			option.setAttribute('aria-label', 'React ' + emoji);
			option.addEventListener('click', () => submit({ kind: 'emoji', body: emoji }));
			emojis.append(option);
		}

		const textarea = document.createElement('textarea');
		textarea.maxLength = YTB.NOTE_MAX_CHARS;
		textarea.rows = 1;
		textarea.placeholder = 'Write a Note...';
		textarea.setAttribute('aria-label', 'Note text');
		// Must attach before our keydown listener so an open popover consumes Enter/Escape first.
		const mentionCtl = window.YTBMentions ? YTBMentions.attach(textarea) : null;
		const counter = document.createElement('div');
		counter.className = 'ytb-note-meta';

		const foot = document.createElement('div');
		foot.className = 'ytb-note-foot';
		const spoiler = document.createElement('input');
		spoiler.type = 'checkbox';
		spoiler.checked = spoilerDefault;
		const spoilerLabel = document.createElement('label');
		spoilerLabel.append(spoiler, document.createTextNode('Spoiler'));
		const post = document.createElement('button');
		post.type = 'button';
		post.className = 'ytb-note-post';
		post.textContent = 'Post';
		post.disabled = true;
		foot.append(spoilerLabel, post);
		composer.append(emojis, textarea, counter, foot, error);

		function updateMeta() {
			counter.textContent = textarea.value.length + ' / ' + YTB.NOTE_MAX_CHARS;
			post.disabled = pending || textarea.value.trim() === '';
			// One visual line that grows to at most two; never manually resizable.
			textarea.style.height = 'auto';
			const line = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
			textarea.style.height = Math.min(textarea.scrollHeight, line * 2 + 16) + 'px';
		}
		updateMeta();

		function setPending(value) {
			pending = value;
			textarea.disabled = value;
			for (const option of emojis.children) option.disabled = value;
			post.textContent = value ? 'Posting...' : 'Post';
			post.disabled = value || textarea.value.trim() === '';
		}

		async function submit({ kind, body }) {
			if (pending) return;
			if (kind === 'text' && !body) return;
			if (kind === 'emoji') {
				textarea.value = ''; // a Reaction discards the typed draft
			}
			setPending(true);
			error.textContent = '';
			const clientId = await YTB.ensureClientId();
			if (!YTB.isContextActive()) return;
			const result = await YTB.postNote({
				clientId,
				name: config.name,
				videoId: currentVideoId,
				// Frozen at post time so a Buddy's Room Feed can name the video (best-effort).
				videoTitle: YTB.watchTitle(document),
				timestamp,
				kind,
				body,
				spoiler: kind === 'emoji' ? false : spoiler.checked,
				// Only Mentions whose "@Name" text survived editing count; a Reaction mentions nobody.
				mentions: kind === 'text' && mentionCtl ? mentionCtl.mentions() : [],
			});
			if (result.ok) {
				// Immediate Video Timeline reconciliation, then close.
				document.dispatchEvent(new CustomEvent('ytb:note-posted', { detail: { note: result.note } }));
				closeComposer();
				return;
			}
			// Failure: keep the panel, the paused-state lease, and the draft.
			setPending(false);
			updateMeta();
			error.textContent = YTB.errorCopy(result.category, kind === 'emoji' ? 'reaction' : 'note');
		}

		textarea.addEventListener('input', updateMeta);
		// theme.js's guard swallows real keydowns (YouTube's hotkeys never see them) and
		// re-dispatches as ytb:keydown with the original event in detail.
		textarea.addEventListener('ytb:keydown', (event) => {
			const key = event.detail.original;
			if (key.key === 'Escape') {
				closeComposer();
				return;
			}
			// Enter posts; Shift+Enter inserts a newline.
			if (key.key === 'Enter' && !key.shiftKey) {
				key.preventDefault();
				submit({ kind: 'text', body: textarea.value.trim() });
			}
		});
		// The guard covers the focused checkbox too (Enter used to re-toggle it instead of
		// posting); Escape must close here since guarded keys never reach the document
		// listener. Space is left unhandled so the checkbox's native toggle still fires.
		spoiler.addEventListener('ytb:keydown', (event) => {
			const key = event.detail.original;
			if (key.key === 'Escape') {
				closeComposer();
				return;
			}
			if (key.key === 'Enter') {
				key.preventDefault();
				submit({ kind: 'text', body: textarea.value.trim() });
			}
		});
		post.addEventListener('click', () => submit({ kind: 'text', body: textarea.value.trim() }));
	}

	function ensureButton() {
		if (!YTB.isContextActive()) return;
		ensureStyles();
		if (!currentVideoId || notesHidden || !hasRoomCode) {
			closeComposer({ resume: false });
			document.getElementById(BUTTON_ID)?.remove();
			return;
		}
		const leftControls = document.querySelector('.ytp-left-controls');
		if (!leftControls) return;
		let button = document.getElementById(BUTTON_ID);
		if (!button) {
			button = document.createElement('button');
			button.id = BUTTON_ID;
			button.type = 'button';
			button.textContent = '+';
			button.title = 'Add a Note';
			button.setAttribute('aria-label', 'Add a Note at the current time');
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				openComposer(button);
			});
		}
		// Only (re)insert when missing/detached, so we don't fight a neighbour extension
		// for position on every mutation -- we tolerate wherever it lands instead.
		if (button.parentElement !== leftControls) leftControls.appendChild(button);
	}

	function repositionIfOpen() {
		const composer = document.getElementById(COMPOSER_ID);
		const button = document.getElementById(BUTTON_ID);
		if (composer && button) positionComposer(composer, button);
	}

	document.addEventListener('ytb:navigate', (event) => {
		currentVideoId = event.detail?.videoId || null;
		closeComposer({ resume: false }); // navigating away discards silently
		ensureButton();
	});
	document.addEventListener('ytb:mutation', () => {
		ensureButton();
		repositionIfOpen();
	});
	// Layout/fullscreen changes move the player; the composer follows its button, never closes.
	window.addEventListener('resize', repositionIfOpen);
	document.addEventListener('fullscreenchange', repositionIfOpen);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeComposer();
	});
	// Record the Press Origin before the composer's descendants see pointerdown, so a drag
	// that later clicks a common player ancestor still routes as composer-owned.
	document.addEventListener(
		'pointerdown',
		(event) => {
			const composerOpen = Boolean(document.getElementById(COMPOSER_ID));
			if (!composerOpen) {
				composerPressOrigin = 'elsewhere';
				return;
			}
			const path = event.composedPath ? event.composedPath() : [event.target];
			composerPressOrigin = path.some((target) => target instanceof Element && target.id === COMPOSER_ID) ? 'overlay' : 'elsewhere';
		},
		true,
	);

	// Shares the capture-phase Picture Click rule with the Expanded Note (ADR-0011); composer
	// controls keep their own handlers, everything else routes through the shared decision seam.
	document.addEventListener(
		'click',
		(event) => {
			const pressOrigin = composerPressOrigin;
			composerPressOrigin = 'elsewhere';
			const composerOpen = Boolean(document.getElementById(COMPOSER_ID));
			if (!composerOpen) return;
			const path = event.composedPath ? event.composedPath() : [];
			for (const target of path) {
				if (!(target instanceof Element)) continue;
				if (target.id === COMPOSER_ID || target.id === BUTTON_ID) return;
			}

			const route = YTB.pictureClickAction({
				overlayOpen: composerOpen,
				region: YTB.pictureClickRegion(event.target),
				pressOrigin,
				pauseHold: pauseLeaseActive,
				withinGrace: YTB.withinArrivalGrace(),
			});
			if (route.consume) {
				event.preventDefault();
				event.stopPropagation();
			}
			if (!route.close) return;
			if (route.cancelArrivalGrace) YTB.cancelArrivalGrace();
			closeComposer({ resume: false });
			if (route.play) document.querySelector('video')?.play();
		},
		true,
	);

	YTB.onContextInvalidated(() => {
		closeComposer({ resume: false });
		document.getElementById(BUTTON_ID)?.remove();
	});
})();
