// extension/mentions.js
//
// The @-mention autocomplete shared by the Add Note composer and the Reply
// input. Per ADR-0006 a Mention targets a STORED Client ID, never display-name
// text: the author types "@", picks a Buddy from a fuzzy-searchable roster
// popover below the field, the inline text renders "@<Display Name>", and the
// posted record carries the picked Client IDs in `mentions`.
//
// Exposes `window.YTBMentions`:
//   - roster()            — current Room members, cached from renderer.js's
//                           `ytb:room-data` rebroadcast (no polling here);
//   - attach(textarea)    — wire the popover to a textarea. Returns a
//                           controller whose mentions() yields the Client IDs
//                           whose inline "@Name" text is still present at
//                           submit time (deleting the text drops the Mention).
//
// attach() must be called BEFORE the caller adds its own ytb:keydown listener
// (the re-dispatch theme.js's keystroke guard emits for on-video inputs):
// while the popover is open, navigation/pick keys are consumed with
// stopImmediatePropagation so Enter picks a member instead of posting.
//
// Loaded after shared.js and before notes.js/composer.js (both attach while
// building their inputs). Pure consumer per ADR-0001 — content.js owns all
// navigation/DOM observation; the only DOM this file touches is its own
// popover.

(function () {
	'use strict';

	const POPOVER_CLASS = 'ytb-mention-popover';
	const OPTION_CLASS = 'ytb-mention-option';
	const STYLE_ID = 'ytb-mentions-style';
	const MAX_VISIBLE = 5;

	let roster = []; // [{ clientId, name }] newest-activity first
	let myClientId = null;

	document.addEventListener('ytb:room-data', (event) => {
		const detail = (event && event.detail) || {};
		myClientId = detail.myClientId || myClientId;
		roster = YTB.roomRoster(detail);
	});

	injectStyle();

	/**
	 * The "@token" the caret currently sits in, or null. The "@" must start a
	 * word (start of text or after whitespace) and the query runs to the caret
	 * with no whitespace — a completed "@Bob " no longer matches.
	 */
	function activeToken(textarea) {
		const caret = textarea.selectionStart;
		if (typeof caret !== 'number') return null;
		const upto = textarea.value.slice(0, caret);
		const at = upto.lastIndexOf('@');
		if (at === -1) return null;
		if (at > 0 && !/\s/.test(upto[at - 1])) return null;
		const query = upto.slice(at + 1);
		if (/\s/.test(query)) return null;
		return { start: at, end: caret, query };
	}

	function attach(textarea) {
		let popover = null;
		let options = []; // [{ element, member }]
		let activeIndex = 0;
		let token = null;
		const picked = []; // [{ clientId, text }] — text presence gates mentions()

		function close() {
			popover?.remove();
			popover = null;
			options = [];
			token = null;
		}

		function ensurePopover() {
			if (popover && popover.isConnected) return popover;
			const parent = textarea.parentElement;
			if (!parent) return null;
			if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
			popover = document.createElement('div');
			popover.className = POPOVER_CLASS;
			popover.setAttribute('role', 'listbox');
			popover.setAttribute('aria-label', 'Mention a Buddy');
			// Below the field, aligned to its left edge.
			popover.style.left = textarea.offsetLeft + 'px';
			popover.style.top = textarea.offsetTop + textarea.offsetHeight + 4 + 'px';
			// Keep player/document handlers from treating popover clicks as
			// outside-clicks or seeks (same contract as the composer/panel).
			for (const type of ['mousedown', 'touchstart', 'pointerdown', 'click', 'dblclick']) {
				popover.addEventListener(type, (e) => e.stopPropagation());
			}
			parent.appendChild(popover);
			return popover;
		}

		function setActive(index) {
			activeIndex = Math.max(0, Math.min(index, options.length - 1));
			options.forEach(({ element }, i) => element.classList.toggle('is-active', i === activeIndex));
		}

		function pick(member) {
			if (!token) return;
			const label = YTB.buddyName(member.clientId, member.name, roster);
			const text = '@' + label;
			const value = textarea.value;
			textarea.value = value.slice(0, token.start) + text + ' ' + value.slice(token.end);
			const caret = token.start + text.length + 1;
			textarea.setSelectionRange(caret, caret);
			if (!picked.some((entry) => entry.clientId === member.clientId && entry.text === text)) {
				picked.push({ clientId: member.clientId, text });
			}
			close();
			textarea.focus();
			// Let the host recount characters / re-enable its post button.
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
		}

		function refresh() {
			token = activeToken(textarea);
			if (!token) {
				close();
				return;
			}
			// Mentionable members: every CURRENT Room member except the author.
			// Search + disambiguate over the FULL roster (so labels match the rest
			// of the UI), then drop myself from the results and cap.
			const candidates = YTB.filterRoster(roster, token.query)
				.filter((member) => member.clientId !== myClientId)
				.slice(0, MAX_VISIBLE);
			if (candidates.length === 0) {
				close();
				return;
			}
			const host = ensurePopover();
			if (!host) return;
			host.replaceChildren();
			options = candidates.map((member, index) => {
				const element = document.createElement('div');
				element.className = OPTION_CLASS;
				element.setAttribute('role', 'option');
				element.textContent = YTB.buddyName(member.clientId, member.name, roster);
				element.style.borderLeftColor = YTB.buddyColor(member.clientId);
				element.addEventListener('click', () => pick(member));
				element.addEventListener('mouseenter', () => setActive(index));
				host.appendChild(element);
				return { element, member };
			});
			setActive(0);
		}

		// Key events arrive as `ytb:keydown` re-dispatches from theme.js's
		// capture guard (YouTube's player hotkeys never see the real events).
		// Registered before the host's own ytb:keydown listener (attach() is
		// called first), so stopImmediatePropagation keeps Enter/Escape from
		// ALSO posting the reply or closing the panel while the popover is open;
		// preventDefault on detail.original cancels the caret/newline default.
		textarea.addEventListener('ytb:keydown', (event) => {
			if (!popover || !popover.isConnected) return;
			const key = event.detail.original;
			if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
				key.preventDefault();
				event.stopImmediatePropagation();
				setActive(activeIndex + (key.key === 'ArrowDown' ? 1 : -1));
			} else if (key.key === 'Enter' || key.key === 'Tab') {
				key.preventDefault();
				event.stopImmediatePropagation();
				const option = options[activeIndex];
				if (option) pick(option.member);
			} else if (key.key === 'Escape') {
				event.stopImmediatePropagation();
				close();
			}
		});
		textarea.addEventListener('input', refresh);
		textarea.addEventListener('blur', () => {
			// Delay so a click on an option lands before the popover goes away.
			setTimeout(() => {
				if (popover && !popover.matches(':hover')) close();
			}, 150);
		});

		return {
			/**
			 * The Client IDs to submit: only Mentions whose inline "@Name" text
			 * survived editing, deduplicated, capped at the Room size.
			 * @returns {string[]}
			 */
			mentions() {
				const value = textarea.value;
				const ids = [];
				for (const entry of picked) {
					if (value.includes(entry.text) && !ids.includes(entry.clientId)) ids.push(entry.clientId);
				}
				return ids.slice(0, YTB.MAX_MEMBERS);
			},
			reset() {
				picked.length = 0;
				close();
			},
			close,
		};
	}

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		// Consumes the namespaced --ytb-* tokens injected by theme.js (the shared
		// on-video apricot foundation), matching the composer/panel it floats in.
		style.textContent = `
      .${POPOVER_CLASS} {
        position: absolute;
        z-index: 2200;
        min-width: 160px;
        max-width: 240px;
        padding: 4px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface);
        box-shadow: var(--ytb-e-pop);
        font: 13px/1.4 var(--ytb-font);
        color: var(--ytb-ink);
      }
      .${OPTION_CLASS} {
        padding: 6px 9px;
        border-left: 3px solid transparent;
        border-radius: var(--ytb-r-sm);
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .${OPTION_CLASS}.is-active { background: var(--ytb-accent-050); }
    `;
		(document.head || document.documentElement).appendChild(style);
	}

	window.YTBMentions = { attach, roster: () => roster };
})();
