// extension/content/notes-alerts.js
// Playback Notification rendering: the alerts stack anchored at the viewer's
// Notification Position, the one-per-beat entrance queue, and both card kinds.
// notes.js owns the triggers (natural crossings + Post Echo) and hands author
// context in via the create() deps.

(function () {
	'use strict';

	const { ALERTS_ID } = YTBNotesUI.NAMES;

	// Concurrent crossings enter one-per-beat on this stagger, in queue order;
	// each notification's own lifetime still starts at its entrance.
	const ENTRANCE_STAGGER_MS = 100;

	/**
	 * deps: getPlayer() -> player root or null; authorFor(note) -> { who, foreign };
	 * onOpen(note) opens the Expanded Note (pauses in place, never seeks).
	 */
	function create({ getPlayer, authorFor, onOpen }) {
		let position = 'bottom'; // Notification Position edge (Settings)
		let queue = [];
		let drainTimer = null; // non-null exactly while a drain is in flight

		// Validate + store the edge and re-anchor a live stack immediately.
		function setPosition(edge) {
			position = YTB.NOTIFICATION_EDGES.includes(edge) ? edge : 'bottom';
			const wrap = document.getElementById(ALERTS_ID);
			const host = getPlayer();
			if (wrap && host) applyPosition(wrap, host);
		}

		function container() {
			const host = getPlayer();
			if (!host) return null;
			let wrap = document.getElementById(ALERTS_ID);
			if (!wrap || wrap.parentElement !== host) {
				wrap?.remove();
				wrap = document.createElement('div');
				wrap.id = ALERTS_ID;
				host.appendChild(wrap);
			}
			applyPosition(wrap, host);
			return wrap;
		}

		// Anchor the stack at the chosen edge and lay children along it:
		// top/bottom is a centered row wrapping away from the edge, left/right a
		// column. Inline styles own placement/axis so a Settings change
		// re-anchors live; the stylesheet carries only the static look.
		function applyPosition(wrap, host) {
			const edge = position;
			const horizontal = edge === 'top' || edge === 'bottom';
			wrap.style.top = '';
			wrap.style.bottom = '';
			wrap.style.left = '';
			wrap.style.right = '';
			wrap.style.transform = '';
			wrap.style.flexDirection = horizontal ? 'row' : 'column';
			// Bottom wraps upward so new lines stay off the edge; a column never
			// wraps (height cap deferred).
			wrap.style.flexWrap = edge === 'bottom' ? 'wrap-reverse' : edge === 'top' ? 'wrap' : 'nowrap';
			wrap.style.justifyContent = horizontal ? 'center' : 'flex-start';
			// Cap a row to the player so it wraps instead of clipping.
			wrap.style.maxWidth = horizontal ? 'calc(100% - 32px)' : '';
			wrap.style.alignItems = edge === 'left' ? 'flex-start' : edge === 'right' ? 'flex-end' : 'center';
			if (horizontal) {
				wrap.style.left = '50%';
				wrap.style.transform = 'translateX(-50%)';
				if (edge === 'top') wrap.style.top = topPx(host) + 'px';
				else wrap.style.bottom = bottomPx(host) + 'px';
			} else {
				wrap.style.top = '50%';
				wrap.style.transform = 'translateY(-50%)';
				if (edge === 'left') wrap.style.left = '16px';
				else wrap.style.right = '16px';
			}
		}

		// Sit above the control bar and any visible caption windows, inside the
		// player, in both watch mode and fullscreen.
		function bottomPx(host) {
			const hostRect = host.getBoundingClientRect();
			let bottom = 16;
			const controls = host.querySelector('.ytp-chrome-bottom');
			if (controls && !host.classList.contains('ytp-autohide')) {
				const rect = controls.getBoundingClientRect();
				if (rect.height > 0) bottom = Math.max(bottom, hostRect.bottom - rect.top + 10);
			}
			for (const caption of host.querySelectorAll('.ytp-caption-window-container .caption-window')) {
				const rect = caption.getBoundingClientRect();
				if (rect.height > 0) bottom = Math.max(bottom, hostRect.bottom - rect.top + 10);
			}
			return Math.min(bottom, Math.max(16, hostRect.height / 2));
		}

		// Top-zone mirror of bottomPx: clear the title/gradient chrome when visible.
		function topPx(host) {
			const hostRect = host.getBoundingClientRect();
			let top = 16;
			const chromeTop = host.querySelector('.ytp-chrome-top');
			if (chromeTop && !host.classList.contains('ytp-autohide')) {
				const rect = chromeTop.getBoundingClientRect();
				if (rect.height > 0) top = Math.max(top, rect.bottom - hostRect.top + 10);
			}
			return Math.min(top, Math.max(16, hostRect.height / 2));
		}

		function showNoteCard(note, trigger) {
			const wrap = container();
			if (!wrap) return;
			const lifetime = YTB.notificationLifetime(note.kind, trigger);
			const { who, foreign } = authorFor(note);
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'ytb-alert-card';
			card.setAttribute('aria-label', `Note by ${who}. Open conversation`);
			const body = document.createElement('div');
			body.className = 'ytb-alert-body';
			body.textContent = note.body;
			const author = document.createElement('div');
			author.className = 'ytb-alert-author';
			author.textContent = who;
			if (foreign) author.style.color = YTB.buddyTextColor(note.clientId);
			// Author beneath the content, matching the Note Preview (no timestamp -
			// a Playback Notification fires exactly as playback crosses the moment).
			card.append(body, author);
			card.addEventListener('click', (event) => {
				event.stopPropagation();
				card.remove();
				onOpen(note);
			});
			wrap.append(card);
			requestAnimationFrame(() => card.classList.add('show'));
			setTimeout(() => {
				card.classList.remove('show');
				setTimeout(() => card.remove(), 250);
			}, lifetime);
		}

		function showReactionBurst(note, trigger) {
			const wrap = container();
			if (!wrap) return;
			const lifetime = YTB.notificationLifetime(note.kind, trigger);
			const { who, foreign } = authorFor(note);
			const burst = document.createElement('div');
			burst.className = 'ytb-alert-burst';
			const emoji = document.createElement('div');
			emoji.className = 'ytb-alert-burst-emoji';
			emoji.textContent = note.body;
			const author = document.createElement('div');
			author.className = 'ytb-alert-burst-author';
			author.textContent = who;
			// Over the raw video (no card): Buddy Color with a shadow keeps
			// identity legible; own bursts stay the default white "You".
			if (foreign) author.style.color = YTB.buddyColor(note.clientId);
			burst.append(emoji, author);
			// Keyframes are percentage-based, so a per-element duration scales the
			// whole float-and-fade (a short echo compresses, never truncates).
			burst.style.animationDuration = `${lifetime}ms`;
			wrap.append(burst);
			setTimeout(() => burst.remove(), lifetime);
		}

		// Queue one notification; earlier ones stay on screen as later ones arrive.
		function enqueue(note, trigger) {
			queue.push({ note, trigger });
			if (drainTimer === null) drainNext();
		}

		function drainNext() {
			const entry = queue.shift();
			if (!entry) {
				drainTimer = null;
				return;
			}
			const { note, trigger } = entry;
			if (note.kind === 'emoji') showReactionBurst(note, trigger);
			else showNoteCard(note, trigger);
			drainTimer = setTimeout(drainNext, ENTRANCE_STAGGER_MS);
		}

		// Drop every on-screen and queued notification and cancel the drain.
		function reset() {
			queue = [];
			if (drainTimer !== null) {
				clearTimeout(drainTimer);
				drainTimer = null;
			}
			document.getElementById(ALERTS_ID)?.replaceChildren();
		}

		return { enqueue, reset, setPosition };
	}

	window.YTBNoteAlerts = { create };
})();
