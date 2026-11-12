// extension/home-section.js
// Room Home Panel (ADR-0005): a floating, left-docked, ephemeral overlay over a
// dim scrim holding the Room Feed + Recommended for you (ADR-0007), or Create/Join
// when Unpaired. Opened by the Room Home Toggle; closed by its close control, a
// scrim click, Esc, or SPA navigation. Owns the ephemeral open state and mirrors
// it to the toggle via ytb:home-panel-state. Connection Lost retains stale content
// (PRD #137); --ytb-* themed (ADR-0009).

(function () {
	'use strict';

	const SECTION_ID = 'ytb-home-section'; // the panel
	const OVERLAY_ID = 'ytb-home-overlay'; // the scrim/root that hosts it
	const STYLE_ID = 'ytb-home-section-style';
	const GUIDE_FALLBACK_PX = 240; // YouTube's own --ytd-guide-width, used until a guide is measurable

	let lastDetail = null; // last renderable ytb:room-data; a same-Room failed read keeps it (PRD #137)
	let connectionLost = false; // true at >= 2 consecutive failed Room reads
	let onHome = false;
	let open = false; // ephemeral: the panel exists only while open (ADR-0005)
	let lastNavUrl = null; // tells a real navigation from a same-URL poller nudge
	let myClientId = null;
	let pendingPair = false; // one Create/Join request at a time
	let activeView = 'normal';
	let viewSettled = true; // false while an open awaits its first Room read to pick the initial view
	let currentSettings = null;
	let currentSharing = true;
	let currentName = '';
	let pendingConfirm = null;
	let selectedBuddyId = '';
	let dismissedIds = new Set(); // this Room's local Dismissals (item ids)
	let dismissedRoom = ''; // the Room Code dismissedIds belongs to

	// Feed reveal window: transient, never persisted; resets on a new home visit or Room change.
	// lastFeedTotal lets a poll that appends while scrolled up grow the window instead of sliding rows away.
	const FEED_PAGE = 20;
	// "At the bottom" tolerance: scrollTop rarely lands exactly on scrollHeight - clientHeight.
	const PIN_PX = 8;
	let revealCount = FEED_PAGE;
	let lastFeedTotal = null; // null: nothing rendered yet to diff against
	let pinOverride = false; // force the next render to the bottom (post-reset)

	function resetFeedWindow() {
		revealCount = FEED_PAGE;
		lastFeedTotal = null;
		pinOverride = true; // a fresh Feed opens scrolled to the newest item
	}

	injectStyle();

	function isHomePath() {
		return location.pathname === '/';
	}

	// Owns the ephemeral open state; the toggle requests a flip and mirrors what we broadcast.
	function setOpen(next) {
		next = Boolean(next);
		if (next === open) return;
		open = next;
		if (open) {
			activeView = initialView();
			viewSettled = Boolean(lastDetail);
			resetFeedWindow(); // each open starts the Feed fresh
			ensureOverlay();
			hydrateSettings();
		} else {
			pendingConfirm = null;
			selectedBuddyId = '';
			teardownOverlay();
		}
		document.dispatchEvent(new CustomEvent('ytb:home-panel-state', { detail: { open } }));
	}

	// --- The floating overlay: scrim + panel on <body>, no YouTube-layout DOM ---

	function ensureOverlay() {
		if (!YTB.isContextActive()) return null;
		if (!open) {
			teardownOverlay();
			return null;
		}
		let root = document.getElementById(OVERLAY_ID);
		let panel = document.getElementById(SECTION_ID);
		if (!root || !root.isConnected) {
			root = document.createElement('div');
			root.id = OVERLAY_ID;
			root.addEventListener('click', (event) => {
				if (event.target === root) setOpen(false); // scrim click closes; panel clicks don't
			});
			// Feed scroll moves rows out from under the cursor; the card must not linger.
			root.addEventListener('scroll', () => hideHoverCard(), true);

			panel = document.createElement('section');
			panel.id = SECTION_ID;
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-modal', 'true');
			panel.setAttribute('aria-label', 'YouTube Buddy Room');
			root.appendChild(panel);
			(document.body || document.documentElement).appendChild(root);
			window.addEventListener('resize', onOverlayResize);
		}
		dockOverlay();
		render(panel);
		return panel;
	}

	function teardownOverlay() {
		hideHoverCard();
		window.removeEventListener('resize', onOverlayResize);
		document.getElementById(OVERLAY_ID)?.remove();
	}

	// A resize re-docks the panel and drops the hover card, whose anchor point is stale.
	function onOverlayResize() {
		dockOverlay();
		hideHoverCard();
	}

	/** Park the panel's left edge just past the guide's right edge, so it reads as popping out of
	 * the sidebar rather than floating over it. Whichever guide is showing (full or mini) wins;
	 * a hidden or absent one measures 0 and falls back to YouTube's full-guide width. */
	function dockOverlay() {
		const root = document.getElementById(OVERLAY_ID);
		if (!root) return;
		const toggleRight = document.getElementById('ytb-home-toggle')?.getBoundingClientRect().right || 0;
		let x = toggleRight < window.innerWidth / 2 ? toggleRight : 0;
		for (const el of document.querySelectorAll('ytd-guide-renderer, ytd-mini-guide-renderer')) {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0 && rect.width < window.innerWidth / 2 && rect.height > 0) x = Math.max(x, rect.right);
		}
		root.style.setProperty('--ytb-hs-dock', `${Math.round(x) || GUIDE_FALLBACK_PX}px`);
	}

	// Esc closes; Tab is trapped inside the modal panel.
	function onOverlayKeydown(event) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			if (pendingConfirm) {
				pendingConfirm = null;
				render();
			} else {
				setOpen(false);
			}
		} else if (event.key === 'Tab') {
			trapFocus(event);
		}
	}

	function trapFocus(event) {
		const panel = document.getElementById(SECTION_ID);
		if (!panel) return;
		const focusables = Array.from(
			panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
		).filter((el) => el.offsetParent !== null);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	// --- Rendering ---

	function render(section) {
		section = section || document.getElementById(SECTION_ID);
		if (!section || !section.isConnected) return;
		hideHoverCard(); // a rebuild detaches the hovered link, so no pointerleave would ever fire

		const detail = lastDetail;
		const roomCode = detail && detail.roomCode;

		// Chat rule: capture scroll before the rebuild - pinned follows the newest item, else keep the exact spot.
		const prevScroll = section.querySelector('.ytb-hs-feed-scroll');
		const prevSettings = section.querySelector('.ytb-hs-settings');
		const prevSettingsTop = prevSettings ? prevSettings.scrollTop : 0;
		const pinned = pinOverride || !prevScroll || prevScroll.scrollHeight - prevScroll.clientHeight - prevScroll.scrollTop <= PIN_PX;
		const prevTop = prevScroll ? prevScroll.scrollTop : 0;
		pinOverride = false;

		const head = document.createElement('header');
		head.className = 'ytb-hs-head';
		const dot = document.createElement('span');
		dot.className = 'ytb-hs-dot';
		const title = document.createElement('h2');
		title.className = 'ytb-hs-title';
		title.textContent = activeView === 'settings' ? 'Settings' : 'YouTube Buddy Room';
		if (activeView === 'settings') head.append(buildBackButton(), title, buildCloseButton());
		else head.append(dot, title, buildSettingsButton(), buildCloseButton());

		// Connection Lost (PRD #137): quiet status line; never shown while Unpaired.
		let conn = null;
		if (roomCode && connectionLost) {
			conn = document.createElement('p');
			conn.className = 'ytb-hs-conn';
			conn.setAttribute('role', 'status');
			conn.textContent = "Can't reach your Room. Retrying...";
		}

		const body = activeView === 'settings' ? buildSettingsView() : document.createElement('div');
		if (activeView === 'normal') {
			body.className = 'ytb-hs-body';
			if (!detail) {
				body.append(buildEmptyNormal('Loading your Room...'));
			} else if (!roomCode) {
				body.append(buildEmptyNormal('Pair with a Room in Settings to see its Feed and Recommendations.'));
			} else if (detail.locked) {
				body.append(buildEmptyNormal('This Room is full. Open Settings to choose another Room.'));
			} else {
				body.append(buildFeedColumn(detail, pinned), buildRecommendedColumn(detail));
			}
		}

		if (conn) section.replaceChildren(head, conn, body);
		else section.replaceChildren(head, body);
		if (pendingConfirm) section.append(buildConfirmDialog());

		const scroll = section.querySelector('.ytb-hs-feed-scroll');
		if (scroll) scroll.scrollTop = pinned ? scroll.scrollHeight : prevTop;
		const settings = section.querySelector('.ytb-hs-settings');
		if (settings) settings.scrollTop = prevSettingsTop;
	}

	function initialView() {
		if (!lastDetail) return 'normal'; // undecided until the first Room read
		return !lastDetail.roomCode || lastDetail.locked ? 'settings' : 'normal';
	}

	function buildEmptyNormal(text) {
		const empty = document.createElement('p');
		empty.className = 'ytb-hs-empty';
		empty.textContent = text;
		return empty;
	}

	function buildSettingsButton() {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ytb-hs-icon';
		button.append(YTBTheme.icon('settings'));
		button.title = 'Settings';
		button.setAttribute('aria-label', 'Settings');
		button.addEventListener('click', () => {
			activeView = 'settings';
			viewSettled = true;
			render();
		});
		return button;
	}

	function buildBackButton() {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ytb-hs-icon ytb-hs-back';
		button.append(YTBTheme.icon('back'));
		button.title = 'Back';
		button.setAttribute('aria-label', 'Back');
		button.addEventListener('click', () => {
			activeView = 'normal';
			viewSettled = true;
			render();
		});
		return button;
	}

	// Closes the panel (ephemeral): a close, never a leave - no Room state is touched.
	function buildCloseButton() {
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'ytb-hs-close';
		close.append(YTBTheme.icon('close'));
		close.title = 'Close the Buddy Room panel';
		close.setAttribute('aria-label', 'Close the Buddy Room panel');
		close.addEventListener('click', () => setOpen(false));
		return close;
	}

	// --- Room Feed (left column) ---

	function buildFeedColumn(detail, pinned) {
		const column = document.createElement('section');
		column.className = 'ytb-hs-feed';
		column.setAttribute('aria-label', 'Room Feed');

		const head = document.createElement('div');
		head.className = 'ytb-hs-col-head';
		head.textContent = 'Room Feed';
		column.append(head);

		const scroll = document.createElement('div');
		scroll.className = 'ytb-hs-feed-scroll';
		column.append(scroll);

		const roster = YTB.roomRoster(detail);
		const groups = YTB.buildFeed(detail, myClientId);
		const total = groups.reduce((sum, group) => sum + group.items.length, 0);

		// Scrolled up, grow revealCount by the delta so appended items don't slide rows away;
		// pinned, the window slides instead (no unbounded DOM growth).
		if (lastFeedTotal !== null && !pinned && total > lastFeedTotal) revealCount += total - lastFeedTotal;
		lastFeedTotal = total;

		if (total === 0) {
			const empty = document.createElement('p');
			empty.className = 'ytb-hs-empty';
			empty.textContent = 'Nothing yet. Notes and replies from your Room land here.';
			scroll.append(empty);
			return column;
		}

		fillFeedScroll(scroll, groups, roster);
		return column;
	}

	// Newest revealCount items behind an inline "Show more"; absent once nothing is hidden.
	function fillFeedScroll(scroll, groups, roster) {
		const { groups: visible, hidden } = YTB.tailFeed(groups, revealCount);
		scroll.replaceChildren();

		if (hidden > 0) {
			const more = document.createElement('button');
			more.type = 'button';
			more.className = 'ytb-hs-more';
			more.textContent = 'Show more';
			more.setAttribute('aria-label', 'Show ' + Math.min(FEED_PAGE, hidden) + ' older Feed items');
			more.addEventListener('click', () => {
				// Compensate scrollTop by the height delta so the viewer's row stays put.
				const prevHeight = scroll.scrollHeight;
				const prevTop = scroll.scrollTop;
				revealCount += FEED_PAGE;
				fillFeedScroll(scroll, groups, roster);
				scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
				// Re-anchor keyboard focus after the rebuild; preventScroll keeps the compensation above.
				const next = scroll.querySelector('.ytb-hs-more');
				const anchor = next || scroll.querySelector('.ytb-hs-item');
				if (anchor) {
					if (!next) anchor.tabIndex = -1;
					anchor.focus({ preventScroll: true });
				}
			});
			scroll.append(more);
		}

		for (const group of visible) {
			const divider = document.createElement('div');
			divider.className = 'ytb-hs-day';
			divider.textContent = YTB.dayLabel(group.dayKey);
			scroll.append(divider);
			for (const item of group.items) {
				if (item.type === 'system') scroll.append(buildSystemRow(item, roster));
				else if (item.type === 'watch') scroll.append(buildWatchRow(item, roster));
				else scroll.append(buildFeedRow(item, roster));
			}
		}
	}

	// --- Video Hover Card: cursor-following thumbnail + title for a Feed link ---
	// Replaces the native title= tooltip on every Feed link, so hovering a Buddy's
	// note previews where it leads. Lives on the overlay root (teardown removes it)
	// and is pointer-events: none, so it never steals the hover that spawned it.

	const HOVER_DELAY_MS = 120; // a cursor crossing rows on its way elsewhere shouldn't flash cards
	let hoverTimer = null;
	let hoverOwner = null; // the link the visible card belongs to
	let hoverPoint = { x: 0, y: 0 };

	function attachVideoHover(el, videoId, title) {
		const plan = YTB.videoHoverCard(videoId, title);
		if (!plan) return el;
		el.addEventListener('pointerenter', (event) => {
			if (event.pointerType === 'touch') return;
			hoverPoint = { x: event.clientX, y: event.clientY };
			clearTimeout(hoverTimer);
			hoverTimer = setTimeout(() => showHoverCard(el, plan), HOVER_DELAY_MS);
		});
		el.addEventListener('pointermove', (event) => {
			hoverPoint = { x: event.clientX, y: event.clientY };
			if (hoverOwner === el) positionHoverCard();
		});
		el.addEventListener('pointerleave', () => hideHoverCard(el));
		el.addEventListener('pointerdown', () => hideHoverCard(el));
		// Keyboard focus gets the same card, anchored under the link instead of a cursor.
		el.addEventListener('focus', () => {
			if (!el.matches(':focus-visible')) return;
			const rect = el.getBoundingClientRect();
			hoverPoint = { x: rect.left, y: rect.bottom };
			showHoverCard(el, plan);
		});
		el.addEventListener('blur', () => hideHoverCard(el));
		return el;
	}

	function ensureHoverCard() {
		const root = document.getElementById(OVERLAY_ID);
		if (!root) return null;
		let card = root.querySelector('.ytb-hs-hovercard');
		if (card) return card;
		card = document.createElement('div');
		card.className = 'ytb-hs-hovercard';
		card.setAttribute('aria-hidden', 'true'); // decorative: the link carries the name AT reads
		const img = document.createElement('img');
		img.className = 'ytb-hs-hovercard-thumb';
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		img.addEventListener('error', () => {
			img.style.display = 'none'; // a missing thumbnail leaves the title, not a broken box
		});
		const label = document.createElement('div');
		label.className = 'ytb-hs-hovercard-label';
		card.append(img, label);
		root.appendChild(card);
		return card;
	}

	function showHoverCard(owner, plan) {
		hoverTimer = null;
		if (!owner.isConnected) return;
		const card = ensureHoverCard();
		if (!card) return;
		const img = card.querySelector('.ytb-hs-hovercard-thumb');
		if (img.getAttribute('src') !== plan.thumbnail) {
			img.style.display = '';
			img.src = plan.thumbnail;
		}
		card.querySelector('.ytb-hs-hovercard-label').textContent = plan.label;
		hoverOwner = owner;
		positionHoverCard();
		card.classList.add('ytb-hs-hovercard-on');
	}

	function positionHoverCard() {
		const card = document.getElementById(OVERLAY_ID)?.querySelector('.ytb-hs-hovercard');
		if (!card) return;
		const at = YTB.hoverCardPlacement({
			x: hoverPoint.x,
			y: hoverPoint.y,
			cardW: card.offsetWidth,
			cardH: card.offsetHeight,
			viewportW: window.innerWidth,
			viewportH: window.innerHeight,
		});
		card.style.left = `${at.left}px`;
		card.style.top = `${at.top}px`;
	}

	// `owner` scopes the hide to one link, so leaving a link the card no longer
	// belongs to can't close a newer one; no owner hides unconditionally.
	function hideHoverCard(owner) {
		if (owner && hoverOwner && hoverOwner !== owner) return;
		clearTimeout(hoverTimer);
		hoverTimer = null;
		hoverOwner = null;
		document.getElementById(OVERLAY_ID)?.querySelector('.ytb-hs-hovercard')?.classList.remove('ytb-hs-hovercard-on');
	}

	function buildFeedRow(item, roster) {
		const record = item.reply || item.note;
		// Replies link to their parent Note's video.
		const target = item.note;
		const canOpen = Boolean(target && target.videoId);
		// Addressed-to-me rows ('reply'/'mention') are the emphasized ones.
		const emphasized = item.type === 'reply' || item.type === 'mention';

		const row = document.createElement('div');
		row.className = emphasized ? 'ytb-hs-item ytb-hs-emph' : 'ytb-hs-item';

		const author = document.createElement('span');
		author.className = 'ytb-hs-author';
		if (item.own) {
			author.textContent = 'You'; // own rows carry no Buddy Color (none is allocated)
		} else {
			author.textContent = YTB.buddyName(record.clientId, record.name, roster);
			author.style.color = YTB.buddyTextColor(record.clientId);
			author.dataset.ytbColorCid = record.clientId; // live repaint hook (#115)
		}

		const spoiler = !item.reply && Boolean(record.spoiler);
		const action = document.createElement('span');
		action.className = 'ytb-hs-action';
		action.textContent = !item.reply
			? spoiler
				? ' left a note on '
				: ' ' + YTB.noteVerb(record.id) + ' '
			: item.type === 'reply'
				? ' replied to your note '
				: item.type === 'mention'
					? ' mentioned you '
					: ' replied ';

		// Notes link their title; Replies link their body. Neither seeks (ADR-0010).
		const body = document.createElement(canOpen ? 'a' : 'span');
		body.className = (canOpen ? 'ytb-hs-text ytb-hs-text-link' : 'ytb-hs-text') + (!item.reply ? ' ytb-hs-video-title' : '');
		body.textContent = item.reply ? '"' + record.body + '"' : target.videoTitle?.trim() || 'a video';
		if (canOpen) {
			body.href = '/watch?v=' + encodeURIComponent(target.videoId);
			if (item.reply) {
				const dest = document.createElement('span');
				dest.className = 'ytb-hs-sr';
				dest.textContent = ' ' + YTB.titleLinkTooltip(target.videoTitle);
				body.append(dest);
			}
			attachVideoHover(body, target.videoId, target.videoTitle);
			body.addEventListener('click', () => {
				YTB.setPendingArrival(target.videoId);
			});
		}

		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);

		row.append(author, action);
		if (!item.reply && !spoiler) {
			const message = document.createElement('span');
			message.className = 'ytb-hs-text';
			message.textContent = '"' + record.body + '"';
			row.append(message, ' on ');
		}
		row.append(body);
		const context = item.reply ? YTB.videoContext(target) : '';
		if (context) {
			const span = document.createElement('span');
			span.className = 'ytb-hs-context';
			span.textContent = ' ' + context;
			row.append(span);
		}
		row.append(when);
		return row;
	}

	// The row's ONLY link (CONTEXT.md Feed link rule); plain text without a videoId
	// (a struck System Message passes null deliberately).
	function buildTitleLink(videoId, title) {
		const label = title || 'a video';
		if (!videoId) return document.createTextNode(label);
		const link = document.createElement('a');
		link.className = 'ytb-hs-title-link';
		link.href = '/watch?v=' + encodeURIComponent(videoId);
		link.textContent = label;
		// The link already reads as the title, so the hover preview is the whole tooltip.
		attachVideoHover(link, videoId, title);
		return link;
	}

	// System Message (ADR-0007), rendered from the pure systemLine plan; a struck line
	// gets no anchor, plus a tooltip and screen-reader suffix (title survives un-recommend).
	function buildSystemRow(item, roster) {
		const line = YTB.systemLine(item, roster);
		const row = document.createElement('div');
		row.className = 'ytb-hs-item ytb-hs-system' + (line.struck ? ' ytb-hs-struck' : '');
		if (line.rowTooltip) row.title = line.rowTooltip;
		const text = document.createElement('span');
		text.append(line.prefix, buildTitleLink(line.linkVideoId, line.label));
		if (line.suffix) text.append(line.suffix);
		if (line.srSuffix) {
			const sr = document.createElement('span');
			sr.className = 'ytb-hs-sr';
			sr.textContent = line.srSuffix;
			text.append(sr);
		}
		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);
		row.append(text, when);
		return row;
	}

	// Watch Notice (recommender only): a Buddy started one of your Recommendations; title is the only link.
	function buildWatchRow(item, roster) {
		const row = document.createElement('div');
		row.className = 'ytb-hs-item ytb-hs-system';
		const text = document.createElement('span');
		text.append(YTB.buddyName(item.clientId, item.name, roster) + ' started watching ', buildTitleLink(item.videoId, item.title));
		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);
		row.append(text, when);
		return row;
	}

	// --- Recommended for you (right column, ADR-0007) ---

	function buildRecommendedColumn(detail) {
		const column = document.createElement('section');
		column.className = 'ytb-hs-playlist';
		column.setAttribute('aria-label', 'Recommended for you');

		const head = document.createElement('div');
		head.className = 'ytb-hs-col-head';
		head.textContent = 'Recommended for you';
		column.append(head);

		// Buddies' Recommendations only (own are hidden, managed from the watch page) minus local Dismissals.
		const roster = YTB.roomRoster(detail);
		const items = YTB.recommendedForYou(detail.playlist, myClientId, dismissedIds);
		if (items.length === 0) {
			const empty = document.createElement('p');
			empty.className = 'ytb-hs-empty';
			empty.textContent = 'Nothing recommended for you yet. When a Buddy recommends a video, it shows up here.';
			column.append(empty);
			return column;
		}

		const count = document.createElement('span');
		count.className = 'ytb-hs-count';
		count.textContent = String(items.length);
		head.append(count);

		const row = document.createElement('div');
		row.className = 'ytb-hs-pl-row';
		for (const item of items) row.append(buildRecommendationCard(item, detail, roster));
		column.append(row);
		return column;
	}

	function buildRecommendationCard(item, detail, roster) {
		const card = document.createElement('div');
		card.className = 'ytb-hs-card';

		const link = document.createElement('a');
		link.className = 'ytb-hs-thumb';
		link.href = '/watch?v=' + encodeURIComponent(item.videoId);
		// No native title= tooltip (alt keeps it accessible); hover shows the card wash instead.
		const img = document.createElement('img');
		// A normal in-page image load on youtube.com - no extra host permission.
		img.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(item.videoId) + '/mqdefault.jpg';
		img.alt = item.title;
		img.loading = 'lazy';
		link.append(img);

		// Dismiss (ADR-0007): private per-viewer, per-Room chrome.storage.local write, never a backend call.
		const dismiss = document.createElement('button');
		dismiss.type = 'button';
		dismiss.className = 'ytb-hs-remove';
		dismiss.append(YTBTheme.icon('close'));
		dismiss.title = 'Dismiss';
		dismiss.setAttribute('aria-label', 'Dismiss "' + item.title + '" from your Recommended for you');
		dismiss.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			dismissedIds.add(item.id); // optimistic: hide this instance immediately
			const code = lastDetail && lastDetail.roomCode;
			if (code) YTB.dismissRecommendation(code, item.id); // persist, best-effort
			render();
		});

		const title = document.createElement('a');
		title.className = 'ytb-hs-card-title';
		title.href = '/watch?v=' + encodeURIComponent(item.videoId);
		title.textContent = item.title;

		const watched = document.createElement('div');
		watched.className = 'ytb-hs-watched';
		const label = YTB.watchedByLabel(detail.progress, item.videoId, myClientId, roster);
		watched.textContent = label ? 'Watched by ' + label : 'New to the Room';

		card.append(link, dismiss, title, watched);
		return card;
	}

	// --- Settings view ---

	async function hydrateSettings() {
		const [settings, config, clientId] = await Promise.all([YTB.getSettings(), YTB.getConfig(), YTB.ensureClientId()]);
		currentSettings = settings;
		currentSharing = config.sharing;
		currentName = config.name || '';
		myClientId = clientId;
		if (open && activeView === 'settings') render();
	}

	function buildSettingsView() {
		const settings = document.createElement('div');
		settings.className = 'ytb-hs-settings';
		settings.append(buildProfileSettings(), buildRoomSettings(), buildOnVideoSettings(), buildAppearanceSettings());
		return settings;
	}

	function buildSettingsGroup(title) {
		const group = document.createElement('section');
		group.className = 'ytb-hs-set-group';
		const heading = document.createElement('h3');
		heading.textContent = title;
		group.append(heading);
		return group;
	}

	function buildProfileSettings() {
		const group = buildSettingsGroup('Profile');
		const label = document.createElement('label');
		label.className = 'ytb-hs-field-label';
		label.textContent = 'Nickname';
		label.htmlFor = 'ytb-hs-name';
		const input = document.createElement('input');
		input.id = 'ytb-hs-name';
		input.className = 'ytb-hs-input ytb-hs-name';
		input.value = currentName;
		input.placeholder = 'Buddy "Buddy" McGee';
		input.autocomplete = 'off';
		input.addEventListener('input', () => YTB.setConfig({ name: input.value }));
		const commit = async () => {
			const name = input.value.trim();
			currentName = name;
			input.value = name;
			await YTB.setConfig({ name });
			const { code } = await YTB.getConfig();
			if (code) await YTB.assertPresence(code);
			requestRoomRefresh();
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') input.blur();
		});
		group.append(label, input);
		return group;
	}

	function roomState() {
		if (!lastDetail || !lastDetail.roomCode) return { label: 'Unpaired', buddies: [], locked: false };
		const view = YTB.roomView(lastDetail, myClientId);
		if (lastDetail.locked || view.locked) return { label: 'Room full', buddies: [], locked: true };
		return {
			label: view.buddies.length ? 'In room' : 'Waiting',
			buddies: view.buddies,
			locked: false,
		};
	}

	function buildRoomSettings() {
		const group = buildSettingsGroup('Room');
		const state = roomState();
		const status = document.createElement('div');
		status.className = 'ytb-hs-room-status';
		status.innerHTML = '<span>Room state</span>';
		const strong = document.createElement('strong');
		strong.textContent = state.label;
		status.append(strong);
		group.append(status);

		const code = lastDetail && lastDetail.roomCode;
		if (code) group.append(buildRoomCode(code));
		if (!code || state.locked) {
			group.append(buildPairPrompt());
		} else {
			group.append(buildRoster(state.buddies));
			const leave = document.createElement('button');
			leave.type = 'button';
			leave.className = 'ytb-hs-btn ytb-hs-danger';
			leave.textContent = 'Leave Room';
			leave.addEventListener('click', confirmLeaveRoom);
			group.append(leave);
		}
		return group;
	}

	function buildRoomCode(code) {
		const row = document.createElement('div');
		row.className = 'ytb-hs-code-row';
		const label = document.createElement('span');
		label.textContent = 'Room Code';
		const value = document.createElement('strong');
		value.textContent = YTBRoomCode.pretty(code);
		const copy = document.createElement('button');
		copy.type = 'button';
		copy.className = 'ytb-hs-copy';
		copy.setAttribute('aria-label', 'Copy Room Code');
		copy.title = 'Copy Room Code';
		const check = YTBTheme.icon('check');
		check.classList.add('ytb-hs-copy-check');
		copy.append(YTBTheme.icon('copy'), check);
		const feedback = document.createElement('span');
		feedback.className = 'ytb-hs-copy-feedback';
		feedback.setAttribute('role', 'status');
		copy.addEventListener('click', () => YTBRoomCode.copy({ text: value.textContent, feedback, button: copy }));
		row.append(label, value, copy, feedback);
		return row;
	}

	function buildRoster(buddies) {
		const wrap = document.createElement('div');
		wrap.className = 'ytb-hs-roster';
		const heading = document.createElement('h4');
		heading.textContent = buddies.length ? `Buddies (${buddies.length})` : 'Buddies';
		wrap.append(heading);
		if (!buddies.length) {
			const empty = document.createElement('p');
			empty.className = 'ytb-hs-set-hint';
			empty.textContent = 'Waiting for a Buddy to join.';
			wrap.append(empty);
			return wrap;
		}

		const roster = YTB.roomRoster(lastDetail);
		for (const buddy of buddies) {
			const row = document.createElement('div');
			row.className = 'ytb-hs-buddy';
			const swatch = document.createElement('button');
			swatch.type = 'button';
			swatch.className = 'ytb-hs-swatch';
			swatch.style.background = YTB.buddyColor(buddy.clientId);
			swatch.setAttribute('aria-label', `Change color for ${YTB.buddyName(buddy.clientId, buddy.name, roster)}`);
			swatch.addEventListener('click', () => {
				selectedBuddyId = selectedBuddyId === buddy.clientId ? '' : buddy.clientId;
				render();
			});
			const name = document.createElement('span');
			name.textContent = YTB.buddyName(buddy.clientId, buddy.name, roster);
			const seen = document.createElement('span');
			seen.className = 'ytb-hs-seen';
			seen.textContent = formatLastSeen(buddy.updatedAt);
			row.append(swatch, name, seen);
			wrap.append(row);
			if (selectedBuddyId === buddy.clientId) wrap.append(buildColorPicker(buddy.clientId));
		}
		return wrap;
	}

	function buildColorPicker(clientId) {
		const picker = document.createElement('div');
		picker.className = 'ytb-hs-colors';
		picker.setAttribute('role', 'group');
		picker.setAttribute('aria-label', 'Buddy Color Swatches');
		const room = YTB._buddyColors[(lastDetail && lastDetail.roomCode) || ''] || {};
		const used = new Set(
			Object.entries(room)
				.filter(([id]) => id !== clientId)
				.map(([, color]) => color),
		);
		for (const color of YTB.BUDDY_COLORS) {
			const choice = document.createElement('button');
			choice.type = 'button';
			choice.className = 'ytb-hs-color';
			choice.style.background = color;
			choice.disabled = used.has(color);
			choice.setAttribute('aria-label', choice.disabled ? `${color}, already assigned` : `Choose ${color}`);
			choice.setAttribute('aria-pressed', String(room[clientId] === color));
			choice.addEventListener('click', async () => {
				if (await YTB.setBuddyColor(lastDetail.roomCode, clientId, color)) {
					selectedBuddyId = '';
					render();
				}
			});
			picker.append(choice);
		}
		return picker;
	}

	function buildOnVideoSettings() {
		const group = buildSettingsGroup('On-video');
		if (!currentSettings) {
			group.append(buildEmptyNormal('Loading Settings...'));
			return group;
		}
		group.append(
			buildSwitch('Share video progress', currentSharing, () => {
				if (currentSharing) confirmStopSharing();
				else setSharing(true);
			}),
			buildSwitch('Notes Visibility', !currentSettings.notesHidden, () => saveSettings({ notesHidden: !currentSettings.notesHidden })),
			buildSwitch('Buddy Progress Visibility', !currentSettings.buddyProgressHidden, () =>
				saveSettings({
					buddyProgressHidden: !currentSettings.buddyProgressHidden,
				}),
			),
			buildSwitch('Spoiler Default', currentSettings.spoilerDefault, () =>
				saveSettings({ spoilerDefault: !currentSettings.spoilerDefault }),
			),
			buildNotificationPicker(),
		);
		return group;
	}

	function buildSwitch(label, checked, onClick) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ytb-hs-switch-row';
		button.setAttribute('role', 'switch');
		button.setAttribute('aria-checked', String(checked));
		const text = document.createElement('span');
		text.textContent = label;
		const toggle = document.createElement('span');
		toggle.className = 'ytb-hs-switch';
		toggle.setAttribute('aria-hidden', 'true');
		toggle.append(document.createElement('span'));
		button.append(text, toggle);
		button.addEventListener('click', onClick);
		return button;
	}

	function buildNotificationPicker() {
		const wrap = document.createElement('div');
		wrap.className = 'ytb-hs-notifications';
		const label = document.createElement('span');
		label.textContent = 'Notification Position';
		const picker = document.createElement('div');
		picker.className = 'ytb-hs-edges';
		picker.setAttribute('role', 'radiogroup');
		picker.setAttribute('aria-label', 'Notification Position');
		for (const edge of ['top', 'left', 'right', 'bottom']) {
			const button = document.createElement('button');
			button.type = 'button';
			button.dataset.edge = edge;
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-label', `Notifications at ${edge}`);
			button.setAttribute('aria-checked', String(currentSettings.notificationPosition === edge));
			button.addEventListener('click', () => saveSettings({ notificationPosition: edge }));
			picker.append(button);
		}
		wrap.append(label, picker);
		return wrap;
	}

	function buildAppearanceSettings() {
		const group = buildSettingsGroup('Appearance');
		const label = document.createElement('span');
		label.textContent = 'Theme Preference';
		const choices = document.createElement('div');
		choices.className = 'ytb-hs-themes';
		choices.setAttribute('role', 'radiogroup');
		choices.setAttribute('aria-label', 'Theme Preference');
		for (const [value, text] of [
			['light', 'Light'],
			['dark', 'Dark'],
			['system', 'Auto'],
		]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.dataset.themeChoice = value;
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(currentSettings && currentSettings.theme === value));
			button.textContent = text;
			button.addEventListener('click', () => saveSettings({ theme: value }));
			choices.append(button);
		}
		group.append(label, choices);
		return group;
	}

	function saveSettings(partial) {
		if (!currentSettings) return;
		currentSettings = { ...currentSettings, ...partial };
		YTB.setSettings(partial);
		render();
	}

	async function setSharing(next) {
		currentSharing = next;
		await YTB.setConfig({ sharing: next });
		render();
	}

	function confirmStopSharing() {
		pendingConfirm = {
			title: 'Stop sharing?',
			body: "Your Buddies won't see your progress until you start again.",
			label: 'Stop sharing',
			danger: false,
			action: () => setSharing(false),
		};
		render();
	}

	async function confirmLeaveRoom() {
		const code = lastDetail && lastDetail.roomCode;
		const state = roomState();
		const roster = YTB.roomRoster(lastDetail);
		const names = state.buddies.map((buddy) => YTB.buddyName(buddy.clientId, buddy.name, roster));
		pendingConfirm = {
			title: names.length ? 'Are you sure you want to go?' : 'Leave this Room?',
			body: names.length ? `This will remove you from the Room, away from: ${names.join(', ')}.` : 'No Buddy has joined the Room yet.',
			label: 'Leave',
			danger: true,
			action: () => leaveRoom(code),
		};
		render();
	}

	function buildConfirmDialog() {
		const overlay = document.createElement('div');
		overlay.className = 'ytb-hs-confirm';
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) {
				pendingConfirm = null;
				render();
			}
		});
		const box = document.createElement('div');
		box.className = 'ytb-hs-confirm-box';
		box.setAttribute('role', 'alertdialog');
		box.setAttribute('aria-modal', 'true');
		const title = document.createElement('h3');
		title.textContent = pendingConfirm.title;
		const body = document.createElement('p');
		body.textContent = pendingConfirm.body;
		const actions = document.createElement('div');
		actions.className = 'ytb-hs-confirm-actions';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'ytb-hs-btn';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => {
			pendingConfirm = null;
			render();
		});
		const confirm = document.createElement('button');
		confirm.type = 'button';
		confirm.className = `ytb-hs-btn ${pendingConfirm.danger ? 'ytb-hs-danger' : 'ytb-hs-neutral'}`;
		confirm.textContent = pendingConfirm.label;
		confirm.addEventListener('click', () => {
			const action = pendingConfirm.action;
			pendingConfirm = null;
			action();
		});
		actions.append(cancel, confirm);
		box.append(title, body, actions);
		overlay.append(box);
		queueMicrotask(() => cancel.isConnected && cancel.focus());
		return overlay;
	}

	async function leaveRoom(code) {
		await YTB.setConfig({ code: '' });
		lastDetail = null;
		selectedBuddyId = '';
		render();
		requestRoomRefresh();
		if (code) {
			await YTB.clearRoomColors(code);
			await YTB.deleteMember(code, myClientId);
		}
	}

	function formatLastSeen(updatedAt) {
		const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
	}

	// --- Unpaired: compact Create/Join prompt ---

	function buildPairPrompt() {
		const wrap = document.createElement('div');
		wrap.className = 'ytb-hs-pair';

		const pitch = document.createElement('p');
		pitch.className = 'ytb-hs-pitch';
		pitch.textContent = 'Watch together, apart. Share progress, notes, and recommendations with up to four friends.';

		const actions = document.createElement('div');
		actions.className = 'ytb-hs-pair-actions';

		const create = document.createElement('button');
		create.type = 'button';
		create.className = 'ytb-hs-btn ytb-hs-btn-primary';
		create.textContent = 'Create a room';

		const joinInput = document.createElement('input');
		joinInput.className = 'ytb-hs-input';
		joinInput.placeholder = 'The Something Somethings';
		joinInput.setAttribute('aria-label', 'Room Code to join');

		const join = document.createElement('button');
		join.type = 'button';
		join.className = 'ytb-hs-btn';
		join.textContent = 'Join';

		const error = document.createElement('p');
		error.className = 'ytb-hs-error';
		error.setAttribute('role', 'status');

		// Only renders while Unpaired, so there is no old Room membership to clean up.
		create.addEventListener('click', async () => {
			if (pendingPair) return;
			pendingPair = true;
			error.textContent = '';
			try {
				const code = YTB.normalizeCode(
					await YTBRoomCode.generateAvailable({
						checkTaken: async (candidate) => {
							const records = await YTB.getRecords(candidate);
							if (!records.ok) return 'failed';
							return YTB.roomExists(records) ? 'taken' : 'free';
						},
					}),
				);
				await commitCode(code);
			} catch (err) {
				if (err instanceof YTBRoomCode.CheckFailedError) {
					error.textContent = "Couldn't reach the server. Try again.";
				} else {
					throw err;
				}
			} finally {
				pendingPair = false;
			}
		});

		const submitJoin = async () => {
			if (pendingPair) return;
			const code = YTB.normalizeCode(joinInput.value);
			if (!code) return;
			pendingPair = true;
			error.textContent = '';
			const records = await YTB.getRecords(code);
			if (!YTB.roomExists(records)) {
				error.textContent = "This room doesn't exist yet";
				pendingPair = false;
				return;
			}
			await commitCode(code);
			pendingPair = false;
		};
		join.addEventListener('click', submitJoin);
		joinInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') submitJoin();
		});

		actions.append(create, joinInput, join);
		wrap.append(pitch, actions, error);
		return wrap;
	}

	async function commitCode(code) {
		const { code: oldCode } = await YTB.getConfig();
		await YTB.setConfig({ code });
		lastDetail = { roomCode: code, myClientId, ok: false, locked: false };
		selectedBuddyId = '';
		render();
		await YTB.assertPresence(code);
		if (oldCode && oldCode !== code) {
			await YTB.clearRoomColors(oldCode);
			await YTB.deleteMember(oldCode, myClientId);
		}
		requestRoomRefresh();
	}

	function requestRoomRefresh() {
		document.dispatchEvent(
			new CustomEvent('ytb:navigate', {
				detail: { url: location.href, videoId: null },
			}),
		);
	}

	// --- Wiring: pure consumer, registered before content.js's first ytb:navigate ---

	document.addEventListener('ytb:navigate', () => {
		if (!YTB.isContextActive()) return;
		const url = location.href;
		const navigated = url !== lastNavUrl;
		lastNavUrl = url;
		onHome = isHomePath();
		// A real navigation closes the panel; a same-URL poller nudge (commitCode) leaves it open.
		if (navigated && open) setOpen(false);
	});

	// The Room Home Toggle requests an open/close; we own the state (ADR-0005).
	document.addEventListener('ytb:home-panel-request-toggle', () => {
		if (!YTB.isContextActive()) return;
		setOpen(!open);
	});

	document.addEventListener(
		'keydown',
		(event) => {
			if (open) onOverlayKeydown(event);
		},
		true,
	);

	document.addEventListener('ytb:room-data', async (event) => {
		if (!YTB.isContextActive()) return;
		const detail = (event && event.detail) || null;
		myClientId = (detail && detail.myClientId) || myClientId;

		// Connection Lost (PRD #137) only applies once there's a Room Code; Unpaired broadcasts never carry the flag.
		connectionLost = Boolean(detail && detail.roomCode && detail.connectionLost);

		// A failed read is not truth: keep the last-known detail, but only for the
		// SAME Room so switching Rooms mid-outage doesn't keep showing the old one.
		const failedRead = Boolean(detail && detail.roomCode && !detail.ok && !detail.locked);
		if (!(failedRead && lastDetail && lastDetail.roomCode === detail.roomCode)) {
			lastDetail = detail;
		}

		// On a Room switch start Dismissals fresh; otherwise merge so an in-flight Dismiss can't flicker back.
		const code = (lastDetail && lastDetail.roomCode) || '';
		if (code !== dismissedRoom) {
			dismissedIds = new Set();
			dismissedRoom = code;
			resetFeedWindow(); // a Room Code change reopens the Feed fresh
		}
		if (code) {
			// On an ok read, prune Dismissed ids no longer live (mirrors pruneSeen); a failed read must not wipe it.
			let persisted;
			if (detail && detail.ok) {
				const liveIds = ((lastDetail && lastDetail.playlist) || []).map((it) => it && it.id).filter(Boolean);
				persisted = await YTB.pruneDismissed(code, liveIds);
			} else {
				persisted = await YTB.dismissedIds(code);
			}
			if (dismissedRoom !== code) return; // switched Rooms mid-read
			for (const id of persisted) dismissedIds.add(id);
		}

		if (open && !viewSettled && lastDetail) {
			activeView = initialView();
			viewSettled = true;
		}
		if (open) ensureOverlay();
	});

	// Buddy Color re-assignment (#115): restyle in place - a re-render would disturb Feed scroll/reveal state.
	document.addEventListener('ytb:buddy-colors', () => {
		if (!YTB.isContextActive()) return;
		const section = document.getElementById(SECTION_ID);
		if (!section) return;
		if (activeView === 'settings') {
			render(section);
			return;
		}
		for (const span of section.querySelectorAll('[data-ytb-color-cid]')) {
			span.style.color = YTB.buddyTextColor(span.dataset.ytbColorCid);
		}
	});

	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area !== 'local') return;
		let shouldRender = false;
		if ('name' in changes) currentName = changes.name.newValue || '';
		if ('sharing' in changes) {
			currentSharing = changes.sharing.newValue !== false;
			shouldRender = true;
		}
		if (['theme', 'spoilerDefault', 'notificationPosition', 'notesHidden', 'buddyProgressHidden'].some((key) => key in changes)) {
			currentSettings = await YTB.getSettings();
			shouldRender = true;
		}
		if (shouldRender && open && activeView === 'settings') render();
	});

	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (!YTB.isContextActive() || message?.type !== 'ytb:open-room-home') return;
		if (onHome) setOpen(true);
		sendResponse({ opened: onHome });
	});

	YTB.onContextInvalidated(() => {
		teardownOverlay();
	});

	/** Inject the section stylesheet once (consumes theme.js's --ytb-* tokens). */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      html:has(#${OVERLAY_ID}), body:has(> #${OVERLAY_ID}) {
        overflow: hidden !important;
        overscroll-behavior: none;
      }
      #${SECTION_ID} .ytb-hs-body,
      #${SECTION_ID} .ytb-hs-settings,
      #${SECTION_ID} .ytb-hs-feed-scroll { overscroll-behavior: contain; }
      /* Scrim/root: covers the page, dims it slightly, catches outside clicks; docks the panel below
         the masthead, just past the guide's right edge (--ytb-hs-dock, measured by dockOverlay). */
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        padding: 64px 16px 20px calc(var(--ytb-hs-dock, ${GUIDE_FALLBACK_PX}px) + 8px);
        background: rgba(0, 0, 0, 0.18);
      }
      /* The floating panel: portrait, roomy, with its own internal scroll. */
      #${SECTION_ID} {
        box-sizing: border-box;
        position: relative;
        display: flex;
        flex-direction: column;
        width: 480px;
        max-width: calc(100vw - var(--ytb-hs-dock, ${GUIDE_FALLBACK_PX}px) - 24px);
        min-height: min(600px, calc(100vh - 84px));
        max-height: calc(100vh - 84px);
        padding: 12px 16px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        font-family: var(--ytb-font);
        font-size: 13px;
        line-height: 1.45;
		box-shadow: var(--ytb-e-pop);
      }
      #${SECTION_ID} .ytb-hs-head { flex: none; display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
      #${SECTION_ID} .ytb-hs-dot {
        align-self: center;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--ytb-accent-500);
      }
      /* Title takes the slack so the close control sits at the right edge. */
      #${SECTION_ID} .ytb-hs-title { flex: 1 1 auto; margin: 0; font-size: 15px; font-weight: 800; color: var(--ytb-ink); }
      #${SECTION_ID} .ytb-hs-close {
        flex: none;
        align-self: center;
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
      #${SECTION_ID} .ytb-hs-close:hover,
      #${SECTION_ID} .ytb-hs-close:focus-visible { background: var(--ytb-accent-050); color: var(--ytb-ink); outline: none; }
      #${SECTION_ID} .ytb-hs-close:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-close svg { width: 14px; height: 14px; }
      #${SECTION_ID} .ytb-hs-icon {
        flex: none; align-self: center; display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
        background: transparent; color: var(--ytb-ink-faint); cursor: pointer;
      }
      #${SECTION_ID} .ytb-hs-icon:hover,
      #${SECTION_ID} .ytb-hs-icon:focus-visible { background: var(--ytb-accent-050); color: var(--ytb-ink); outline: none; }
      #${SECTION_ID} .ytb-hs-icon:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-icon svg { width: 15px; height: 15px; }
      /* Portrait stack: Feed above Recommended (ADR-0005); the body scrolls if the two exceed the panel. */
      #${SECTION_ID} .ytb-hs-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
      #${SECTION_ID} .ytb-hs-feed { min-width: 0; }
      #${SECTION_ID} .ytb-hs-playlist { min-width: 0; }
      #${SECTION_ID} .ytb-hs-col-head {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 4px;
        font-size: 11px; font-weight: 600; color: var(--ytb-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-count { font-weight: 500; }
      #${SECTION_ID} .ytb-hs-feed-scroll {
        max-height: 380px;
        overflow-y: auto;
        padding: 8px;
        border-radius: 12px;
        background: var(--ytb-surface-tint);
      }
      #${SECTION_ID} .ytb-hs-day {
        margin: 8px 0 4px;
        text-align: center;
        font-size: 11px; font-weight: 600;
        color: var(--ytb-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-day:first-child { margin-top: 0; }
      /* Show more: inline above the topmost day divider, scrolls with content (not sticky); adds no height to the section. */
      #${SECTION_ID} .ytb-hs-more {
        display: block;
        width: 100%;
        margin: 0 0 4px;
        padding: 4px 8px;
        border: 0;
        border-radius: var(--ytb-r-sm);
        background: var(--ytb-accent-050);
        color: var(--ytb-accent-800);
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
        cursor: pointer;
        transition: background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${SECTION_ID} .ytb-hs-more:hover { background: var(--ytb-accent-100); }
      #${SECTION_ID} .ytb-hs-more:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-item { margin: 4px 0; overflow-wrap: anywhere; }
      /* Addressed-to-you rows (replies to your Notes, @mentions of you) read louder than the plain comment stream. */
      #${SECTION_ID} .ytb-hs-item.ytb-hs-emph {
        padding: 4px 8px;
        border-left: 3px solid var(--ytb-accent-500);
        border-radius: var(--ytb-r-sm);
        background: var(--ytb-accent-050);
      }
      #${SECTION_ID} .ytb-hs-emph .ytb-hs-action { color: var(--ytb-accent-800); font-weight: 600; }
      #${SECTION_ID} .ytb-hs-video-title {
        display: inline-block;
        max-width: min(28ch, 100%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
        font-style: italic;
      }
      #${SECTION_ID} a.ytb-hs-text-link {
        color: inherit;
        text-decoration: none;
        border-radius: 6px;
        cursor: pointer;
        transition: background 120ms ease;
      }
      /* Pointer hover is underline only (#171); the wash and ring belong to :focus-visible below. */
      #${SECTION_ID} a.ytb-hs-text-link:hover {
        text-decoration: underline;
      }
      #${SECTION_ID} a.ytb-hs-text-link:focus-visible {
        outline: none;
        background: var(--ytb-accent-050);
        box-shadow: 0 0 0 3px var(--ytb-ring);
        text-decoration: underline;
      }
      #${SECTION_ID} .ytb-hs-author { font-weight: 700; }
      #${SECTION_ID} .ytb-hs-action { color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-context { color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-when { margin-left: 8px; font-size: 11px; color: var(--ytb-ink-muted); white-space: nowrap; }
      #${SECTION_ID} .ytb-hs-system { font-size: 11px; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link {
        color: var(--ytb-accent-800);
        font-weight: 600;
        text-decoration: none;
      }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:hover { text-decoration: underline; }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:focus-visible { text-decoration: underline; outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      /* Struck System Message (ADR-0007): sentence struck, timestamp stays legible. */
      #${SECTION_ID} .ytb-hs-struck > span { text-decoration: line-through; }
      /* Screen-reader-only text: a line-through alone conveys nothing to AT. */
      #${SECTION_ID} .ytb-hs-sr {
        position: absolute;
        width: 1px; height: 1px;
        margin: -1px; padding: 0; border: 0;
        clip-path: inset(50%);
        overflow: hidden;
        white-space: nowrap;
      }
      #${SECTION_ID} .ytb-hs-empty { margin: 4px 0; font-size: 13px; color: var(--ytb-ink-muted); }
      /* Connection Lost (PRD #137): quiet and deemphasized - the retained content below stays the focus. */
      #${SECTION_ID} .ytb-hs-conn { margin: -4px 0 8px; font-size: 11px; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-pl-row {
        display: flex; flex-wrap: wrap; gap: 12px;
        /* Cards wrap into rows in the portrait panel; padding leaves room for the card hover wash's bleed. */
        padding: 8px 6px 10px;
      }
      /* isolate makes the card a stacking context so the ::before wash (z-index -1) stays behind its own content. */
      #${SECTION_ID} .ytb-hs-card { position: relative; isolation: isolate; flex: 0 0 132px; width: 132px; }
      /* Card hover wash (#200) bleeds within the 12px row gap so adjacent washes never collide; keyboard focus uses rings. */
      #${SECTION_ID} .ytb-hs-card::before {
        content: ''; position: absolute; z-index: -1; inset: -6px -4px;
        border-radius: var(--ytb-r-lg); background: var(--ytb-accent-050);
        opacity: 0; pointer-events: none;
        transition: opacity var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${SECTION_ID} .ytb-hs-card:hover::before { opacity: 1; }
      #${SECTION_ID} .ytb-hs-thumb { display: block; border-radius: 12px; overflow: hidden; }
      #${SECTION_ID} .ytb-hs-thumb:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-thumb img { display: block; width: 132px; height: 74px; object-fit: cover; }
      #${SECTION_ID} .ytb-hs-card-title {
        margin-top: 4px;
        font-size: 11px; font-weight: 600; line-height: 1.3;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        color: inherit; text-decoration: none;
      }
      #${SECTION_ID} .ytb-hs-card-title:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-watched { margin-top: 0; font-size: 11px; color: var(--ytb-ink-muted); }
      /* Theme-independent dark scrim + light glyph: legible on any thumbnail frame. */
      /* 24x24 hit target around a 20px visual scrim (UA-005): transparent border widens the box while background-clip keeps the circle at 20px. */
      #${SECTION_ID} .ytb-hs-remove {
        position: absolute; top: 1px; right: 1px;
        width: 24px; height: 24px;
        display: inline-flex; align-items: center; justify-content: center;
        padding: 0; border: 2px solid transparent; border-radius: 12px;
        background: rgba(0, 0, 0, 0.65); background-clip: padding-box; color: #fff;
        cursor: pointer;
        opacity: 0;
        transition: opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #${SECTION_ID} .ytb-hs-remove svg { width: 14px; height: 14px; }
      /* Card hover only reveals the Dismiss control; the ring is keyboard focus's alone (#171). */
      #${SECTION_ID} .ytb-hs-card:hover .ytb-hs-remove { opacity: 1; }
      #${SECTION_ID} .ytb-hs-remove:focus-visible { opacity: 1; outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-remove:disabled { opacity: 0.4; cursor: default; }
      #${SECTION_ID} .ytb-hs-pair { display: flex; flex-direction: column; gap: 8px; }
      #${SECTION_ID} .ytb-hs-pitch { margin: 0; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-pair-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      /* One control height across Create/input/Join (UA-009): shared line-height and a transparent border on the primary keep the three boxes equal. */
      #${SECTION_ID} .ytb-hs-btn {
        padding: 8px 12px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: 12px;
        background: var(--ytb-surface-tint);
        color: var(--ytb-ink);
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        transition: transform 140ms cubic-bezier(0.34, 1.3, 0.64, 1), background 140ms;
      }
      #${SECTION_ID} .ytb-hs-btn:active { transform: scale(0.97); }
      #${SECTION_ID} .ytb-hs-btn-primary { border-color: transparent; background: var(--ytb-accent-500); color: var(--ytb-on-accent); }
      #${SECTION_ID} .ytb-hs-input {
        min-width: 190px;
        padding: 8px 12px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: 8px;
        background: var(--ytb-surface-sunk);
        color: var(--ytb-ink);
        font-family: inherit;
		font-size: 13px;
		line-height: 1.2;
		box-sizing: border-box;
      }
      #${SECTION_ID} .ytb-hs-input:focus { outline: none; border-color: var(--ytb-accent-500); box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-error { margin: 0; min-height: 16px; font-size: 11px; color: var(--ytb-danger-text); }
      #${SECTION_ID} .ytb-hs-settings {
        flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 4px 8px 0;
        display: flex; flex-direction: column; gap: 12px;
      }
      #${SECTION_ID} .ytb-hs-set-group {
        padding: 12px; border: 1px solid var(--ytb-line); border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface-tint);
      }
      #${SECTION_ID} .ytb-hs-set-group h3,
		#${SECTION_ID} .ytb-hs-set-group h4 { margin: 0 0 8px; font-size: 11px; font-weight: 800; }
      #${SECTION_ID} .ytb-hs-field-label { display: block; margin-bottom: 5px; color: var(--ytb-ink-muted); font-size: 11px; }
      #${SECTION_ID} .ytb-hs-name { width: 100%; }
      #${SECTION_ID} .ytb-hs-room-status,
      #${SECTION_ID} .ytb-hs-code-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      #${SECTION_ID} .ytb-hs-room-status > span,
      #${SECTION_ID} .ytb-hs-code-row > span:first-child { color: var(--ytb-ink-muted); }
		#${SECTION_ID} .ytb-hs-room-status strong,
		#${SECTION_ID} .ytb-hs-code-row strong { margin-left: auto; }
		#${SECTION_ID} .ytb-hs-code-row strong { color: var(--ytb-accent-800); font-size: 16px; font-weight: 800; }
      #${SECTION_ID} .ytb-hs-copy {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 4px; border: 1px solid var(--ytb-line-strong); border-radius: var(--ytb-r-sm);
        background: var(--ytb-surface); color: var(--ytb-ink); cursor: pointer;
      }
      #${SECTION_ID} .ytb-hs-code-row { flex-wrap: wrap; }
      #${SECTION_ID} .ytb-hs-copy-feedback { flex-basis: 100%; color: var(--ytb-ink-muted); font-size: 11px; text-align: right; }
      #${SECTION_ID} .ytb-hs-copy-feedback:empty { display: none; }
      #${SECTION_ID} .ytb-hs-copy-feedback.is-error { color: var(--ytb-danger-text); }
      #${SECTION_ID} .ytb-hs-copy svg { width: 18px; height: 18px; }
      #${SECTION_ID} .ytb-hs-copy .ytb-hs-copy-check,
      #${SECTION_ID} .ytb-hs-copy.is-copied > svg { display: none; }
      #${SECTION_ID} .ytb-hs-copy.is-copied > .ytb-hs-copy-check { display: block; }
      #${SECTION_ID} .ytb-hs-copy:hover { background: var(--ytb-accent-050); }
      #${SECTION_ID} .ytb-hs-copy.is-copied { color: var(--ytb-accent-800); background: var(--ytb-accent-100); }
      #${SECTION_ID} .ytb-hs-copy:focus-visible,
      #${SECTION_ID} .ytb-hs-swatch:focus-visible,
      #${SECTION_ID} .ytb-hs-color:focus-visible,
      #${SECTION_ID} .ytb-hs-themes button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-roster { margin: 10px 0; }
      #${SECTION_ID} .ytb-hs-buddy { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 0; }
      #${SECTION_ID} .ytb-hs-swatch,
      #${SECTION_ID} .ytb-hs-color { border: 2px solid transparent; border-radius: 2px; cursor: pointer; }
      #${SECTION_ID} .ytb-hs-swatch { width: 24px; height: 24px; padding: 0; }
      #${SECTION_ID} .ytb-hs-seen { color: var(--ytb-ink-muted); font-size: 11px; }
      #${SECTION_ID} .ytb-hs-colors { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0 8px 32px; }
      #${SECTION_ID} .ytb-hs-color { flex: none; width: 24px; height: 24px; padding: 0; }
      #${SECTION_ID} .ytb-hs-color[aria-pressed='true'] { box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-color:disabled { opacity: 0.25; cursor: default; }
		#${SECTION_ID} .ytb-hs-danger { border-color: transparent; background: var(--ytb-danger); color: var(--ytb-on-fill); }
		#${SECTION_ID} .ytb-hs-neutral { border-color: transparent; background: var(--ytb-neutral); color: var(--ytb-on-fill); }
      #${SECTION_ID} .ytb-hs-set-hint { margin: 4px 0; color: var(--ytb-ink-muted); font-size: 11px; }
      #${SECTION_ID} .ytb-hs-switch-row {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 8px 0; border: 0; border-bottom: 1px solid var(--ytb-line);
        background: transparent; color: var(--ytb-ink); font: 600 13px/1.3 var(--ytb-font); text-align: left; cursor: pointer;
      }
      #${SECTION_ID} .ytb-hs-switch-row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); border-radius: 8px; }
      #${SECTION_ID} .ytb-hs-switch { width: 34px; height: 20px; padding: 2px; border-radius: 999px; background: var(--ytb-line-strong); }
      #${SECTION_ID} .ytb-hs-switch > span {
        display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--ytb-surface);
        box-shadow: 0 1px 3px oklch(52% 0.06 52 / 0.25); transition: transform 140ms;
      }
      #${SECTION_ID} .ytb-hs-switch-row[aria-checked='true'] .ytb-hs-switch { background: var(--ytb-accent-500); }
      #${SECTION_ID} .ytb-hs-switch-row[aria-checked='true'] .ytb-hs-switch > span { transform: translateX(14px); }
      #${SECTION_ID} .ytb-hs-notifications { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px; font-weight: 600; }
      #${SECTION_ID} .ytb-hs-edges { flex: none; width: 80px; height: 80px; display: grid; grid-template: repeat(3, 24px) / repeat(3, 24px); gap: 4px; }
      #${SECTION_ID} .ytb-hs-edges button { border: 1px solid var(--ytb-line-strong); border-radius: var(--ytb-r-sm); background: var(--ytb-surface); cursor: pointer; }
      #${SECTION_ID} .ytb-hs-edges button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-edges button[data-edge='top'] { grid-area: 1 / 2; }
      #${SECTION_ID} .ytb-hs-edges button[data-edge='left'] { grid-area: 2 / 1; }
      #${SECTION_ID} .ytb-hs-edges button[data-edge='right'] { grid-area: 2 / 3; }
      #${SECTION_ID} .ytb-hs-edges button[data-edge='bottom'] { grid-area: 3 / 2; }
      #${SECTION_ID} .ytb-hs-edges button[aria-checked='true'] { border-color: var(--ytb-accent-700); background: var(--ytb-accent-500); }
      #${SECTION_ID} .ytb-hs-themes { display: flex; gap: 4px; margin-top: 7px; }
      #${SECTION_ID} .ytb-hs-themes button {
        flex: 1; padding: 7px; border: 1px solid var(--ytb-line-strong); border-radius: 8px;
        background: var(--ytb-surface); color: var(--ytb-ink); font: 600 13px/1.45 var(--ytb-font); cursor: pointer;
      }
      #${SECTION_ID} .ytb-hs-themes button[aria-checked='true'] { border-color: var(--ytb-accent-700); background: var(--ytb-accent-100); }
      #${SECTION_ID} .ytb-hs-confirm {
        position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center;
        padding: 20px; border-radius: var(--ytb-r-lg); background: rgba(0, 0, 0, 0.35);
      }
      #${SECTION_ID} .ytb-hs-confirm-box { width: 100%; padding: 16px; border-radius: var(--ytb-r-lg); background: var(--ytb-surface); box-shadow: var(--ytb-e-dialog); }
      #${SECTION_ID} .ytb-hs-confirm-box h3 { margin: 0 0 5px; font-size: 15px; }
      #${SECTION_ID} .ytb-hs-confirm-box p { margin: 0 0 14px; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
      /* Video Hover Card: follows the cursor, so pointer-events must stay off it. */
      #${OVERLAY_ID} .ytb-hs-hovercard {
        position: fixed;
        left: 0; top: 0;
        box-sizing: border-box;
        width: 200px;
        padding: 6px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        font-family: var(--ytb-font);
        font-size: 11px;
        line-height: 1.3;
		box-shadow: var(--ytb-e-pop);
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      #${OVERLAY_ID} .ytb-hs-hovercard-on { opacity: 1; visibility: visible; }
      #${OVERLAY_ID} .ytb-hs-hovercard-thumb {
        display: block;
        width: 186px; height: 105px;
        border-radius: 8px;
        object-fit: cover;
        background: var(--ytb-surface-sunk);
      }
      #${OVERLAY_ID} .ytb-hs-hovercard-label {
        margin-top: 5px;
        font-weight: 600;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      @media (prefers-reduced-motion: reduce) {
		#${SECTION_ID} .ytb-hs-btn, #${SECTION_ID} .ytb-hs-remove, #${SECTION_ID} .ytb-hs-close, #${SECTION_ID} .ytb-hs-icon, #${SECTION_ID} .ytb-hs-more, #${SECTION_ID} .ytb-hs-switch > span { transition: none; }
        #${OVERLAY_ID} .ytb-hs-hovercard { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
