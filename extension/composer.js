// composer.js - add-only Note composer attached to YouTube's player controls.
// Purely consumes content.js navigation/mutation events; it does not observe the
// page itself. The button is re-applied because YouTube frequently rebuilds the
// controls during SPA navigation.

(function () {
	'use strict';

	const BUTTON_ID = 'ytb-note-button';
	const COMPOSER_ID = 'ytb-note-composer';
	let currentVideoId = null;
	let openToken = 0;

	function ensureStyles() {
		if (document.getElementById('ytb-composer-styles')) return;
		const style = document.createElement('style');
		style.id = 'ytb-composer-styles';
		style.textContent = `
      #${BUTTON_ID} { flex: 0 0 auto; width: 34px; height: 100%; margin: 0 2px; padding: 0; border: 0; background: transparent; color: #fff; cursor: pointer; opacity: .9; font: 700 18px/1 Arial,sans-serif; }
      #${BUTTON_ID}:hover, #${BUTTON_ID}:focus-visible { opacity: 1; background: rgba(255,255,255,.12); outline: none; }
      #${COMPOSER_ID} { position: fixed; z-index: 2147483646; width: min(330px, calc(100vw - 24px)); box-sizing: border-box; padding: 14px; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; background: #212121; color: #fff; box-shadow: 0 8px 30px rgba(0,0,0,.55); font: 13px/1.4 Roboto,Arial,sans-serif; }
      #${COMPOSER_ID} .ytb-note-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      #${COMPOSER_ID} .ytb-note-title { font-weight: 600; font-size: 15px; }
      #${COMPOSER_ID} .ytb-note-time { color: #aaa; font-variant-numeric: tabular-nums; }
      #${COMPOSER_ID} textarea { display: block; width: 100%; min-height: 72px; resize: vertical; box-sizing: border-box; padding: 9px; border: 1px solid #555; border-radius: 6px; background: #181818; color: #fff; font: inherit; }
      #${COMPOSER_ID} textarea:focus { border-color: #3ea6ff; outline: none; }
      #${COMPOSER_ID} .ytb-note-meta { height: 20px; text-align: right; color: #aaa; font-size: 12px; }
      #${COMPOSER_ID} .ytb-note-emojis { display: flex; gap: 5px; margin: 2px 0 11px; }
      #${COMPOSER_ID} .ytb-note-emoji { width: 36px; height: 34px; border: 1px solid #555; border-radius: 6px; background: #303030; cursor: pointer; font-size: 18px; }
      #${COMPOSER_ID} .ytb-note-emoji[aria-pressed="true"] { border-color: #3ea6ff; background: #16476b; }
      #${COMPOSER_ID} .ytb-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      #${COMPOSER_ID} label { display: flex; align-items: center; gap: 6px; }
      #${COMPOSER_ID} .ytb-note-post { padding: 7px 14px; border: 0; border-radius: 18px; background: #3ea6ff; color: #0f0f0f; font-weight: 600; cursor: pointer; }
      #${COMPOSER_ID} .ytb-note-post:disabled { background: #555; color: #aaa; cursor: default; }
      #${COMPOSER_ID} .ytb-note-message { margin: 0 0 10px; color: #f2c94c; }
      #${COMPOSER_ID} .ytb-note-error { min-height: 18px; margin-top: 7px; color: #ff8a80; }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	function closeComposer() {
		openToken += 1;
		document.getElementById(COMPOSER_ID)?.remove();
	}

	function positionComposer(composer, button) {
		const rect = button.getBoundingClientRect();
		const width = Math.min(330, window.innerWidth - 24);
		composer.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
		composer.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px';
	}

	async function openComposer(button) {
		if (document.getElementById(COMPOSER_ID)) {
			closeComposer();
			return;
		}
		const video = document.querySelector('video');
		if (!video || !currentVideoId) return;
		const timestamp = Math.max(0, Number(video.currentTime) || 0);
		const token = ++openToken;
		const config = await YTB.getConfig();
		if (token !== openToken || !button.isConnected) return;

		const composer = document.createElement('section');
		composer.id = COMPOSER_ID;
		composer.setAttribute('role', 'dialog');
		composer.setAttribute('aria-label', 'Add a Note');
		composer.innerHTML = `<div class="ytb-note-head"><span class="ytb-note-title">Add a Note</span><time class="ytb-note-time"></time></div>`;
		composer.querySelector('.ytb-note-time').textContent = YTB.formatTime(timestamp);

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

		document.body.append(composer);
		positionComposer(composer, button);
		composer.querySelector('textarea')?.focus();
	}

	function buildForm(composer, config, timestamp) {
		const textarea = document.createElement('textarea');
		textarea.maxLength = 200;
		textarea.placeholder = 'Write a Note...';
		textarea.setAttribute('aria-label', 'Note text');
		const counter = document.createElement('div');
		counter.className = 'ytb-note-meta';
		counter.textContent = '0 / 200';
		const emojis = document.createElement('div');
		emojis.className = 'ytb-note-emojis';
		emojis.setAttribute('aria-label', 'Reactions');
		let selectedEmoji = '';
		for (const emoji of YTB.NOTE_EMOJIS) {
			const option = document.createElement('button');
			option.type = 'button';
			option.className = 'ytb-note-emoji';
			option.textContent = emoji;
			option.setAttribute('aria-label', 'React ' + emoji);
			option.setAttribute('aria-pressed', 'false');
			option.addEventListener('click', () => {
				selectedEmoji = selectedEmoji === emoji ? '' : emoji;
				textarea.value = '';
				counter.textContent = '0 / 200';
				for (const item of emojis.children) item.setAttribute('aria-pressed', String(item === option && selectedEmoji !== ''));
				updatePost();
			});
			emojis.append(option);
		}
		textarea.addEventListener('input', () => {
			selectedEmoji = '';
			for (const item of emojis.children) item.setAttribute('aria-pressed', 'false');
			counter.textContent = textarea.value.length + ' / 200';
			updatePost();
		});
		const foot = document.createElement('div');
		foot.className = 'ytb-note-foot';
		const spoiler = document.createElement('input');
		spoiler.type = 'checkbox';
		const spoilerLabel = document.createElement('label');
		spoilerLabel.append(spoiler, document.createTextNode('Spoiler'));
		const post = document.createElement('button');
		post.type = 'button';
		post.className = 'ytb-note-post';
		post.textContent = 'Post';
		post.disabled = true;
		foot.append(spoilerLabel, post);
		const error = document.createElement('div');
		error.className = 'ytb-note-error';
		error.setAttribute('role', 'status');
		composer.append(textarea, counter, emojis, foot, error);

		function updatePost() {
			post.disabled = textarea.value.trim() === '' && selectedEmoji === '';
		}

		post.addEventListener('click', async () => {
			const body = selectedEmoji || textarea.value.trim();
			if (!body) return;
			post.disabled = true;
			post.textContent = 'Posting...';
			error.textContent = '';
			const clientId = await YTB.ensureClientId();
			const result = await YTB.postNote({
				clientId,
				name: config.name,
				videoId: currentVideoId,
				timestamp,
				kind: selectedEmoji ? 'emoji' : 'text',
				body,
				spoiler: spoiler.checked,
			});
			if (result) closeComposer();
			else {
				error.textContent = 'Could not post the Note. Try again.';
				post.textContent = 'Post';
				updatePost();
			}
		});
	}

	function ensureButton() {
		ensureStyles();
		if (!currentVideoId) {
			closeComposer();
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

	document.addEventListener('ytb:navigate', (event) => {
		currentVideoId = event.detail?.videoId || null;
		closeComposer();
		ensureButton();
	});
	document.addEventListener('ytb:mutation', ensureButton);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeComposer();
	});
})();
