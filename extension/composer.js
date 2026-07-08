// composer.js - the Add Note composer, attached to YouTube's player controls.
// Purely consumes content.js navigation/mutation events; it does not observe the
// page itself. The button is re-applied because YouTube frequently rebuilds the
// controls during SPA navigation.
//
// The composer is player-bound, not viewport-bound: it lives INSIDE
// #movie_player, anchored above its Add Note button, clamped fully within the
// video, so it scrolls out with the player and survives fullscreen transitions.
// Opening captures the current timestamp and pauses in place (tracking whether
// the video was playing); closing, posting a Note, or posting a Reaction
// resumes only if opening paused a playing video. Every dismissal — the X,
// Escape, the button toggle, any outside click — discards the draft without
// confirmation. Successful posts hand the complete server record to notes.js
// via `ytb:note-posted` for immediate Video Timeline reconciliation.
//
// Styling consumes the namespaced --ytb-* tokens + 'YTB Rounded' face injected
// by theme.js (the shared on-video apricot foundation); theme.js also isolates
// keystrokes in the Note textarea from YouTube's player hotkeys.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-note-button';
	const COMPOSER_ID = 'ytb-note-composer';
	let currentVideoId = null;
	let openToken = 0;
	let pauseLeaseActive = false; // opening the composer paused a playing video

	// Settings (live via chrome.storage.onChanged): the Spoiler Default seeds
	// the composer's checkbox on each open, and Notes Visibility off removes
	// the Add Note (+) button entirely (the player carries zero YTB Note UI).
	let spoilerDefault = true;
	let notesHidden = false;

	YTB.getSettings().then((settings) => {
		spoilerDefault = settings.spoilerDefault;
		notesHidden = settings.notesHidden;
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
	});

	// Styling consumes the namespaced --ytb-* tokens + 'YTB Rounded' face
	// injected by theme.js (the shared on-video apricot foundation). The Add
	// Note BUTTON stays player-native white — it lives inside YouTube's own
	// control bar, where an apricot chip would clash.
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
        padding: 14px 16px;
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
      #${COMPOSER_ID} .ytb-note-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      #${COMPOSER_ID} .ytb-note-title { font-weight: 800; font-size: 15px; }
      #${COMPOSER_ID} .ytb-note-time { margin-left: auto; color: var(--ytb-ink-muted); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
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
      #${COMPOSER_ID} .ytb-note-emojis { display: flex; gap: 6px; margin: 0 0 10px; }
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
        padding: 8px 10px;
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
      #${COMPOSER_ID} .ytb-note-meta { height: 18px; margin-top: 2px; text-align: right; color: var(--ytb-ink-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
      #${COMPOSER_ID} .ytb-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      #${COMPOSER_ID} label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--ytb-ink-muted); }
      #${COMPOSER_ID} input[type='checkbox'] { accent-color: var(--ytb-accent-600); }
      #${COMPOSER_ID} .ytb-note-post {
        padding: 7px 16px;
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
      #${COMPOSER_ID} .ytb-note-message { margin: 0 0 10px; color: var(--ytb-accent-800); font-weight: 600; }
      #${COMPOSER_ID} .ytb-note-error { min-height: 18px; margin-top: 7px; color: var(--ytb-danger-text); font-size: 12px; font-weight: 600; }
      @media (prefers-reduced-motion: reduce) {
        #${COMPOSER_ID} { animation: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	/**
	 * Close and discard the draft. Resumes playback only when opening the
	 * composer paused a playing video (a video that was already paused stays
	 * paused). Pass `resume: false` on navigation, where the video is changing.
	 */
	function closeComposer({ resume = true } = {}) {
		openToken += 1;
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

		if (!config.sharing) {
			const message = document.createElement('p');
			message.className = 'ytb-note-message';
			message.textContent = 'Turn on Sharing in YouTube Buddy to post a Note.';
			composer.append(message);
			const disabled = document.createElement('button');
			disabled.className = 'ytb-note-post';
			disabled.disabled = true;
			disabled.textContent = 'Post';
			composer.append(disabled);
		} else {
			buildForm(composer, config, timestamp);
		}

		// Keep composer interactions inside the composer: no player seeks/pauses,
		// and the document-level outside-click dismissal never sees these events.
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'click', 'dblclick']) {
			composer.addEventListener(type, (e) => e.stopPropagation());
		}

		host.append(composer);
		positionComposer(composer, button);
		composer.querySelector('textarea')?.focus();
	}

	function buildForm(composer, config, timestamp) {
		let pending = false;
		const error = document.createElement('div');
		error.className = 'ytb-note-error';
		error.setAttribute('role', 'status');

		// One-click Reactions, above the Note field: clicking immediately submits
		// that Reaction (never a Spoiler) and discards any typed draft.
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
		// The @-mention popover must attach BEFORE our own keydown listener so an
		// open popover consumes Enter/Escape instead of posting/closing.
		const mentionCtl = window.YTBMentions ? YTBMentions.attach(textarea) : null;
		const counter = document.createElement('div');
		counter.className = 'ytb-note-meta';

		const foot = document.createElement('div');
		foot.className = 'ytb-note-foot';
		const spoiler = document.createElement('input');
		spoiler.type = 'checkbox';
		spoiler.checked = spoilerDefault; // seeded from the Spoiler Default setting on EVERY opening
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
				timestamp,
				kind,
				body,
				spoiler: kind === 'emoji' ? false : spoiler.checked,
				// Only Mentions whose inline "@Name" text survived editing count;
				// a one-click Reaction discards the draft, so it mentions nobody.
				mentions: kind === 'text' && mentionCtl ? mentionCtl.mentions() : [],
			});
			if (result.ok) {
				// Immediate Video Timeline reconciliation, then close (resuming only
				// if opening paused a playing video).
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
		// theme.js's window-capture guard swallows real keydowns on this textarea
		// (YouTube's player hotkeys never see them) and re-dispatches them as
		// ytb:keydown with the original event in detail.
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
		post.addEventListener('click', () => submit({ kind: 'text', body: textarea.value.trim() }));
	}

	function ensureButton() {
		if (!YTB.isContextActive()) return;
		ensureStyles();
		if (!currentVideoId || notesHidden) {
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
		// Append to the end of the left control cluster, i.e. after the timecode
		// and any neighbouring extensions' buttons (e.g. Language Reactor). Only
		// (re)insert when the button is missing or detached from the current
		// control bar, so we never fight a neighbour for the same slot on every
		// mutation -- we tolerate its position instead of re-anchoring adjacently.
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
	// Layout and fullscreen changes move the player; the composer follows its
	// button (fullscreen transitions do NOT close it).
	window.addEventListener('resize', repositionIfOpen);
	document.addEventListener('fullscreenchange', repositionIfOpen);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeComposer();
	});
	// Clicking anywhere outside dismisses and discards (composer + button clicks
	// stop propagation, so they never land here).
	document.addEventListener('click', () => {
		if (document.getElementById(COMPOSER_ID)) closeComposer();
	});

	YTB.onContextInvalidated(() => {
		closeComposer({ resume: false });
		document.getElementById(BUTTON_ID)?.remove();
	});
})();
