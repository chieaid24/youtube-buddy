// extension/home-section.js
// Room Home Section (ADR-0005): Room Feed + Recommended for you (ADR-0007) above
// the home grid, or Create/Join when Unpaired. Gated to home route + Room Home
// Toggle; Connection Lost retains stale content (PRD #137); --ytb-* themed (ADR-0009).

(function () {
	'use strict';

	const SECTION_ID = 'ytb-home-section';
	const STYLE_ID = 'ytb-home-section-style';

	let lastDetail = null; // last renderable ytb:room-data; a same-Room failed read keeps it (PRD #137)
	let connectionLost = false; // true at >= 2 consecutive failed Room reads
	let onHome = false;
	let myClientId = null;
	let pendingPair = false; // one Create/Join request at a time
	let pendingHide = false; // one header-close write at a time
	let hiddenPref = null; // null until the stored preference is read, so the section never flashes in
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

	YTB.getHomeSectionHidden().then((value) => {
		if (hiddenPref === null) hiddenPref = value;
		ensureSection();
	});

	function isHomePath() {
		return location.pathname === '/';
	}

	// --- Injection: above the home grid, retried on mutations until it lands ---

	function ensureSection() {
		if (!YTB.isContextActive()) return null;
		// Absent off home, while toggled off, or until the preference is known.
		if (!onHome || hiddenPref !== false) {
			document.getElementById(SECTION_ID)?.remove();
			return null;
		}
		let section = document.getElementById(SECTION_ID);
		if (section && section.isConnected) return section;

		// Directly above the home grid so YouTube's layout pushes it down.
		const browse = document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])');
		const grid = browse && browse.querySelector('ytd-rich-grid-renderer');
		if (!grid || !grid.parentElement) return null; // grid not built yet - retried on ytb:mutation

		section = document.createElement('section');
		section.id = SECTION_ID;
		section.setAttribute('aria-label', 'YouTube Buddy Room');
		grid.parentElement.insertBefore(section, grid);
		render(section);
		return section;
	}

	// --- Rendering ---

	function render(section) {
		section = section || document.getElementById(SECTION_ID);
		if (!section || !section.isConnected) return;

		const detail = lastDetail;
		const roomCode = detail && detail.roomCode;

		// Chat rule: capture scroll before the rebuild - pinned follows the newest item, else keep the exact spot.
		const prevScroll = section.querySelector('.ytb-hs-feed-scroll');
		const pinned = pinOverride || !prevScroll || prevScroll.scrollHeight - prevScroll.clientHeight - prevScroll.scrollTop <= PIN_PX;
		const prevTop = prevScroll ? prevScroll.scrollTop : 0;
		pinOverride = false;

		const head = document.createElement('header');
		head.className = 'ytb-hs-head';
		const dot = document.createElement('span');
		dot.className = 'ytb-hs-dot';
		const title = document.createElement('h2');
		title.className = 'ytb-hs-title';
		title.textContent = 'YouTube Buddy Room';
		head.append(dot, title);
		if (roomCode) {
			const code = document.createElement('span');
			code.className = 'ytb-hs-code';
			code.textContent = window.YTBRoomCode ? YTBRoomCode.pretty(roomCode) : roomCode;
			head.append(code);
		}
		head.append(buildCloseButton());

		// Connection Lost (PRD #137): quiet status line; never shown while Unpaired.
		let conn = null;
		if (roomCode && connectionLost) {
			conn = document.createElement('p');
			conn.className = 'ytb-hs-conn';
			conn.setAttribute('role', 'status');
			conn.textContent = "Can't reach your Room. Retrying...";
		}

		const body = document.createElement('div');
		body.className = 'ytb-hs-body';
		if (!roomCode) {
			body.append(buildPairPrompt());
		} else if (detail.locked) {
			const locked = document.createElement('p');
			locked.className = 'ytb-hs-empty';
			locked.textContent = 'This Room is full, so nothing can be shown here.';
			body.append(locked);
		} else {
			body.append(buildFeedColumn(detail, pinned), buildRecommendedColumn(detail));
		}

		if (conn) section.replaceChildren(head, conn, body);
		else section.replaceChildren(head, body);

		const scroll = section.querySelector('.ytb-hs-feed-scroll');
		if (scroll) scroll.scrollTop = pinned ? scroll.scrollHeight : prevTop;
	}

	// Third writer of homeSectionHidden (with the guide toggle + popup Settings):
	// a hide, never a leave; optimistic, chrome.storage.onChanged syncs peers.
	function buildCloseButton() {
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'ytb-hs-close';
		close.append(YTBTheme.icon('close'));
		close.title = 'Hide the Buddy Room section (turn it back on from the guide)';
		close.setAttribute('aria-label', 'Hide the Buddy Room section');
		close.addEventListener('click', async () => {
			if (pendingHide || hiddenPref !== false) return;
			pendingHide = true;
			hiddenPref = true;
			applyVisibility();
			await YTB.setHomeSectionHidden(true);
			pendingHide = false;
		});
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
			empty.textContent = 'Nothing yet. Replies to your notes and @mentions of you land here.';
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

	function buildFeedRow(item, roster) {
		const record = item.reply || item.note;
		// Parent Note for a Reply, the Note itself for a Mention; absent leaves the body non-clickable.
		const target = item.note;
		const canOpen = Boolean(target && target.videoId);

		const row = document.createElement('div');
		row.className = 'ytb-hs-item';

		const author = document.createElement('span');
		author.className = 'ytb-hs-author';
		author.textContent = YTB.buddyName(record.clientId, record.name, roster);
		author.style.color = YTB.buddyTextColor(record.clientId);
		author.dataset.ytbColorCid = record.clientId; // live repaint hook (#115)

		const action = document.createElement('span');
		action.className = 'ytb-hs-action';
		action.textContent = item.type === 'reply' ? ' replied to your note ' : ' mentioned you ';

		// Only the quoted body links (CONTEXT.md Feed link rule): no &t= seek (ADR-0010),
		// plus an arrival handshake so notes.js pauses on an Unseen dot there.
		const body = document.createElement(canOpen ? 'a' : 'span');
		body.className = canOpen ? 'ytb-hs-text ytb-hs-text-link' : 'ytb-hs-text';
		body.textContent = '"' + record.body + '"';
		if (canOpen) {
			body.href = '/watch?v=' + encodeURIComponent(target.videoId);
			// Tooltip names the destination video (the row doesn't otherwise show it).
			body.title = YTB.titleLinkTooltip(target.videoTitle);
			body.addEventListener('click', () => {
				YTB.setPendingArrival(target.videoId);
			});
		}

		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);

		row.append(author, action, body);
		// Video context: plain text, never a link; absent if the Note predates title capture.
		const context = YTB.videoContext(target);
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
		link.title = YTB.titleLinkTooltip(title);
		link.textContent = label;
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

		// Same flows as the popup (ADR-0005); only renders while Unpaired, so there's no old-Room membership to clean up.
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
		await YTB.setConfig({ code });
		await YTB.assertPresence(code);
		// Nudge renderer.js's poller to re-read now instead of waiting out its 60s cycle.
		document.dispatchEvent(
			new CustomEvent('ytb:navigate', {
				detail: { url: location.href, videoId: null },
			}),
		);
	}

	// --- Wiring: pure consumer, registered before content.js's first ytb:navigate ---

	document.addEventListener('ytb:navigate', () => {
		if (!YTB.isContextActive()) return;
		const wasHome = onHome;
		onHome = isHomePath();
		// A new visit to home resets the reveal window; same-page navigates (e.g. commitCode's nudge) keep it.
		if (onHome && !wasHome) resetFeedWindow();
		ensureSection();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		// YouTube rebuilds browse contents lazily; keep the section present without re-rendering.
		ensureSection();
	});

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

		const section = ensureSection();
		if (section) render(section);
	});

	// Room Home Toggle flip (home-toggle.js).
	document.addEventListener('ytb:home-section-visibility', (event) => {
		if (!YTB.isContextActive()) return;
		hiddenPref = Boolean(event.detail && event.detail.hidden);
		applyVisibility();
	});

	// Popup-Settings flips reach this tab only via storage.onChanged (idempotent with the path above).
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.homeSectionHidden || !YTB.isContextActive()) return;
		hiddenPref = changes.homeSectionHidden.newValue === true;
		applyVisibility();
	});

	// Buddy Color re-assignment (#115): restyle in place - a re-render would disturb Feed scroll/reveal state.
	document.addEventListener('ytb:buddy-colors', () => {
		if (!YTB.isContextActive()) return;
		const section = document.getElementById(SECTION_ID);
		if (!section) return;
		for (const span of section.querySelectorAll('[data-ytb-color-cid]')) {
			span.style.color = YTB.buddyTextColor(span.dataset.ytbColorCid);
		}
	});

	function applyVisibility() {
		const section = ensureSection();
		if (section) render(section);
	}

	YTB.onContextInvalidated(() => {
		document.getElementById(SECTION_ID)?.remove();
	});

	/** Inject the section stylesheet once (consumes theme.js's --ytb-* tokens). */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${SECTION_ID} {
        box-sizing: border-box;
        margin: 12px 8px 4px;
        padding: 12px 16px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        font-family: var(--ytb-font);
        font-size: 13px;
        line-height: 1.45;
      }
      #${SECTION_ID} .ytb-hs-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
      #${SECTION_ID} .ytb-hs-dot {
        align-self: center;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--ytb-accent-500);
      }
      /* Title takes the slack so the Room Code and close control sit at the right edge either way. */
      #${SECTION_ID} .ytb-hs-title { flex: 1 1 auto; margin: 0; font-size: 15px; font-weight: 800; color: var(--ytb-ink); }
      #${SECTION_ID} .ytb-hs-code { font-size: 13px; font-weight: 800; color: var(--ytb-accent-800); }
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
      #${SECTION_ID} .ytb-hs-body { display: flex; gap: 12px; align-items: stretch; }
      #${SECTION_ID} .ytb-hs-feed { flex: 1 1 46%; min-width: 0; }
      #${SECTION_ID} .ytb-hs-playlist { flex: 1 1 54%; min-width: 0; }
      #${SECTION_ID} .ytb-hs-col-head {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 4px;
        font-size: 11px; font-weight: 600; color: var(--ytb-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-count { font-weight: 500; }
      #${SECTION_ID} .ytb-hs-feed-scroll {
        max-height: 148px;
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
        display: flex; gap: 12px;
        overflow-x: auto;
        /* Room for the card hover wash's bleed (x:auto also clips y); extra bottom clears the scrollbar. */
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
      }
      #${SECTION_ID} .ytb-hs-input:focus { outline: none; border-color: var(--ytb-accent-500); box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-error { margin: 0; min-height: 16px; font-size: 11px; color: var(--ytb-danger-text); }
      @media (prefers-reduced-motion: reduce) {
        #${SECTION_ID} .ytb-hs-btn, #${SECTION_ID} .ytb-hs-remove, #${SECTION_ID} .ytb-hs-close, #${SECTION_ID} .ytb-hs-more { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
