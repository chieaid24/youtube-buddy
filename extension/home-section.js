// extension/home-section.js
//
// The Room Home Section (ADR-0005): a compact two-column panel injected at the
// top of the YouTube HOME page, above the recommendations grid (which shifts
// down). Left: the Room Feed — a chronological, chat-like feed of Replies to
// the viewer's Notes, @-mentions of the viewer, deemphasized recommend System
// Messages ("X recommended ..." to recipients, "You recommended ... to the
// Room" to the recommender; struck through per Event once superseded or
// un-recommended — ADR-0007), and Watch Notices ("X started watching ...",
// shown to the recommender when a Buddy watches their pick), grouped under day
// dividers, newest at the bottom. The Feed is windowed to the newest 20 items
// behind an inline "Show more" control (YTB.tailFeed), and follows the chat
// rule: it auto-scrolls to the newest item only while the viewer is already
// at the bottom, otherwise the rebuild preserves their exact scroll position.
// Feed link rule (CONTEXT.md): on a reply/mention row only the quoted body
// links — to the video at YOUR OWN place (`/watch?v=<id>`, no `&t=` seek,
// ADR-0010): you arrive paused with the Unseen dot(s) pulsing, and choose
// which to open; on System Messages and Watch Notices only the video title links
// (to the video's watch page). Everything else in a row — author, action,
// context, timestamp — is plain text, and a struck System Message is the sole
// exception: no link at all.
// Right: Recommended for you (ADR-0007) — the Room's Recommendations whose
// `addedBy` is NOT the viewer, minus locally Dismissed videoIds, as a
// horizontal thumbnail row with a live "Watched by ..." attribution and a
// Dismiss control (local-only; un-recommending one's OWN items happens on the
// watch-page pill, never here). Unpaired installs get a compact Create/Join
// prompt (same YTB / YTBRoomCode calls as the popup, which stays the source
// of truth for identity and Room membership).
//
// Strictly gated to the home route ('/'); re-injected after SPA navigations
// back to home. Also gated by the Room Home Toggle (home-toggle.js): while
// the per-install homeSectionHidden preference is on, the section is absent
// from the page entirely. The preference is read once on load and updated
// live via `ytb:home-section-visibility`. The header's close control is a
// third writer of that same preference (alongside the guide toggle and the
// popup's Settings view), so closing the section here is the identical state
// — absent, not collapsed — and the guide row is what restores it; the write
// reaches the guide row and the popup over chrome.storage.onChanged, the same
// channel the popup's control already uses. Pure consumer per ADR-0001:
// content.js emits
// ytb:navigate/ytb:mutation, renderer.js polls the Room and rebroadcasts every
// read as `ytb:room-data` — this file makes no reads of its own (the only
// writes are Create/Join and their presence assert; a Dismiss or a close only
// touches chrome.storage.local).
//
// Connection Lost (PRD #137): a failed Room read (`ok: false` on the
// broadcast) retains the last-known Feed and Recommendations instead of
// rebuilding them from the failure's empty arrays, and while the broadcast's
// `connectionLost` flag is up (>= 2 consecutive failures) a quiet
// "Can't reach your Room — retrying…" line sits under the header. The first
// successful read clears the line and rebuilds as normal. Unpaired installs
// are unaffected — the flag only rides broadcasts that carry a Room Code.
//
// Styling consumes theme.js's shared --ytb-* tokens (ADR-0009): this is a normal
// on-page token surface with no private palette of its own, so it inherits the
// apricot ramp, warm neutrals, motion, and the bundled 'YTB Rounded' font, and
// follows the Theme Preference — including Auto tracking YouTube's own theme —
// exactly like the on-video Note UI.

(function () {
	'use strict';

	const SECTION_ID = 'ytb-home-section';
	const STYLE_ID = 'ytb-home-section-style';

	let lastDetail = null; // most recent RENDERABLE ytb:room-data payload (a failed
	// Room read for the same Room retains the previous one — Connection Lost,
	// PRD #137 — so the Feed and Recommendations never blank out on a blip)
	let connectionLost = false; // >= 2 consecutive failed Room reads (broadcast flag)
	let onHome = false;
	let myClientId = null;
	let pendingPair = false; // one Create/Join request at a time
	let pendingHide = false; // one header-close write at a time
	// Room Home Toggle state: null until the stored preference has been read,
	// so the section never flashes in before a hide preference is known.
	let hiddenPref = null;
	let dismissedIds = new Set(); // this Room's local Dismissals (videoIds)
	let dismissedRoom = ''; // the Room Code dismissedIds belongs to

	// The Feed's reveal window — transient view state (a number in module
	// state, deliberately never chrome.storage.local: the Feed has no
	// read/unread state by design). Only the newest `revealCount` items render;
	// each "Show more" click reveals FEED_PAGE older ones. The count survives
	// polls, ytb:mutation re-injection attempts, and the Dismiss re-render; it
	// resets on a new visit to the home route and on a Room Code change —
	// reopening the Feed is like reopening a chat. `lastFeedTotal` remembers the
	// previous render's FULL item count so items a poll appends while the
	// viewer is scrolled up grow the window rather than sliding visible rows
	// out of its top.
	const FEED_PAGE = 20;
	// "At the bottom" tolerance: fractional scroll heights and zoom rounding
	// mean scrollTop rarely lands exactly on scrollHeight - clientHeight.
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

	// ---------------------------------------------------------------------------
	// Injection: above the home grid, re-attempted on mutations until it lands.
	// ---------------------------------------------------------------------------

	function ensureSection() {
		if (!YTB.isContextActive()) return null;
		// Absent off the home route, while the Room Home Toggle is off, and
		// until the stored toggle preference is known (hiddenPref === null).
		if (!onHome || hiddenPref !== false) {
			document.getElementById(SECTION_ID)?.remove();
			return null;
		}
		let section = document.getElementById(SECTION_ID);
		if (section && section.isConnected) return section;

		// The visible home browse hosts one rich grid; the section sits directly
		// above it so YouTube's own layout pushes the grid down.
		const browse = document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])');
		const grid = browse && browse.querySelector('ytd-rich-grid-renderer');
		if (!grid || !grid.parentElement) return null; // grid not built yet — retry on ytb:mutation

		section = document.createElement('section');
		section.id = SECTION_ID;
		section.setAttribute('aria-label', 'YouTube Buddy Room');
		grid.parentElement.insertBefore(section, grid);
		render(section);
		return section;
	}

	// ---------------------------------------------------------------------------
	// Rendering.
	// ---------------------------------------------------------------------------

	function render(section) {
		section = section || document.getElementById(SECTION_ID);
		if (!section || !section.isConnected) return;

		const detail = lastDetail;
		const roomCode = detail && detail.roomCode;

		// The chat rule: capture the Feed's scroll state BEFORE the rebuild wipes
		// it. Pinned to the bottom (or no Feed yet) means "follow the newest";
		// scrolled up means the viewer is reading their history — preserve their
		// exact spot instead of yanking them back down.
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

		// Connection Lost (PRD #137): a quiet, deemphasized line under the header
		// while the Room can't be read — the retained Feed and Recommendations
		// keep rendering beneath it, and the first successful read clears it.
		// Never shown while Unpaired (the flag is only set once there is a code).
		let conn = null;
		if (roomCode && connectionLost) {
			conn = document.createElement('p');
			conn.className = 'ytb-hs-conn';
			conn.setAttribute('role', 'status');
			conn.textContent = "Can't reach your Room — retrying…";
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

		// Chat order: follow the newest item only while the viewer was already at
		// the bottom; otherwise restore their exact scroll position — the window
		// growth above guarantees the same rows still sit at the same offsets.
		const scroll = section.querySelector('.ytb-hs-feed-scroll');
		if (scroll) scroll.scrollTop = pinned ? scroll.scrollHeight : prevTop;
	}

	// The header's close control: a third entry point to the same per-install
	// homeSectionHidden preference the Room Home Toggle and the popup's Settings
	// view drive, so hiding from here is the identical state (section absent,
	// not collapsed) and the guide row is what brings it back. Removal is
	// optimistic; chrome.storage.onChanged then syncs the guide row and popup.
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

		// Items a poll appended while the viewer is scrolled up must not slide
		// the row they are reading out of the top of the window: grow the reveal
		// count by the number appended. Pinned to the bottom, the count stays put
		// and the window slides instead — an idle home page must not grow its
		// DOM without bound.
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

	// Populate the Feed's scroll region: the newest `revealCount` items
	// (YTB.tailFeed), behind a "Show more" control that sits above the topmost
	// day divider, inline in the scroll content — it scrolls with the history
	// rather than floating over it, and it is absent once nothing older is
	// hidden. Re-run in place on each reveal.
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
				// Reveal the next page and leave the viewer looking at the same row:
				// every height change happens ABOVE the previously-topmost visible row
				// (rows prepended, this control replaced or removed), so compensating
				// scrollTop by the height delta keeps that row exactly where it was.
				const prevHeight = scroll.scrollHeight;
				const prevTop = scroll.scrollTop;
				revealCount += FEED_PAGE;
				fillFeedScroll(scroll, groups, roster);
				scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
				// Keep the keyboard anchored (the rebuild dropped the old control):
				// focus its successor, or on the final reveal the first revealed row,
				// rather than dropping the keyboard user onto the document. Never let
				// focus() scroll — that would undo the compensation above.
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
		// The Note this row points at: the parent Note for a Reply or a
		// Reply-Mention, the Note itself for a Note-Mention. Absent (parent not in
		// this Room read) leaves the quoted body non-clickable.
		const target = item.note;
		const canOpen = Boolean(target && target.videoId);

		const row = document.createElement('div');
		row.className = 'ytb-hs-item';

		const author = document.createElement('span');
		author.className = 'ytb-hs-author';
		author.textContent = YTB.buddyName(record.clientId, record.name, roster);
		author.style.color = YTB.buddyTextColor(record.clientId);
		author.dataset.ytbColorCid = record.clientId; // live repaint hook (issue #115)

		const action = document.createElement('span');
		action.className = 'ytb-hs-action';
		action.textContent = item.type === 'reply' ? ' replied to your note ' : ' mentioned you ';

		// Only the quoted body is the link (CONTEXT.md Room Feed link rule): the
		// author, action, context, and timestamp stay plain text, so clicking
		// anywhere but the body does nothing. The anchor navigates to the video at
		// YOUR OWN place — `/watch?v=<id>` with no `&t=` seek (ADR-0010, SPA on
		// YouTube, full reload in tests) — and records a short-lived arrival
		// handshake so notes.js pauses you there IF an Unseen dot is on that video.
		// No preventDefault: the anchor IS the navigation.
		const body = document.createElement(canOpen ? 'a' : 'span');
		body.className = canOpen ? 'ytb-hs-text ytb-hs-text-link' : 'ytb-hs-text';
		body.textContent = '"' + record.body + '"';
		if (canOpen) {
			body.href = '/watch?v=' + encodeURIComponent(target.videoId);
			// The visible text is the quoted body; the tooltip names where the link
			// lands (the parent Note's video, which a reply row need not otherwise show).
			body.title = YTB.titleLinkTooltip(target.videoTitle);
			body.addEventListener('click', () => {
				YTB.setPendingArrival(target.videoId);
			});
		}

		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);

		row.append(author, action, body);
		// Which video the conversation is on — plain deemphasized text, never a
		// link of its own. Notes posted before Notes captured a title have none,
		// and then the row just doesn't name the video (no placeholder).
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

	// The video title as a System Message / Watch Notice row's ONLY link
	// (CONTEXT.md Room Feed link rule) — the rest of the line stays plain
	// deemphasized text. Falls back to plain text without a videoId; a struck
	// System Message rides that fallback on purpose (systemLine hands it a null
	// videoId), so a dead recommendation renders no anchor at all.
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

	// A recommendation System Message (ADR-0007 amendment): recipients see
	// 'Bob recommended Title', the recommender their own 'You recommended Title
	// to the Room'. The whole sentence comes from the pure systemLine plan
	// (shared.js): on a live line only the title links to the video; a struck
	// line — buildFeed flagged the item `removed`, a per-Event state — renders
	// no anchor at all, its title plain muted text, plus a row tooltip and a
	// visually-hidden suffix since a line-through says nothing to a screen
	// reader. The stored event title survives an un-recommend, so the sentence
	// stays correct even after the live Playlist Item is gone.
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

	// A Watch Notice, shown only to the recommender: a Buddy has a Progress
	// Record for one of the viewer's Recommendations. Title comes from the live
	// Recommendation (carried on the item) and is the row's only link; the
	// watcher's name via buddyName.
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

		// The viewer's personalized grid: Buddies' Recommendations only (own are
		// hidden — you manage those from the watch page), minus local Dismissals.
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
		link.title = item.title;
		const img = document.createElement('img');
		// A normal in-page image load on youtube.com — no extra host permission.
		img.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(item.videoId) + '/mqdefault.jpg';
		img.alt = item.title;
		img.loading = 'lazy';
		link.append(img);

		// Dismiss (ADR-0007): hide this Recommendation for THIS viewer in THIS
		// Room only — a private chrome.storage.local write, never a backend call.
		// Other members are unaffected; the hide persists across reloads.
		const dismiss = document.createElement('button');
		dismiss.type = 'button';
		dismiss.className = 'ytb-hs-remove';
		dismiss.textContent = '×';
		dismiss.title = 'Dismiss';
		dismiss.setAttribute('aria-label', 'Dismiss "' + item.title + '" from your Recommended for you');
		dismiss.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			dismissedIds.add(item.videoId); // optimistic: hide immediately
			const code = lastDetail && lastDetail.roomCode;
			if (code) YTB.dismissVideo(code, item.videoId); // persist, best-effort
			render();
		});

		const title = document.createElement('a');
		title.className = 'ytb-hs-card-title';
		title.href = '/watch?v=' + encodeURIComponent(item.videoId);
		title.title = item.title;
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

		// Same flows as the popup (ADR-0005: both entry points stay behaviorally
		// consistent). This prompt only renders while Unpaired, so there is no
		// old-Room membership to clean up.
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
		// Nudge the single poller (renderer.js) to re-read the Room immediately
		// instead of waiting out its 60s cycle. Idempotent for every consumer:
		// it re-emits the CURRENT location, exactly like a same-page navigation.
		document.dispatchEvent(
			new CustomEvent('ytb:navigate', {
				detail: { url: location.href, videoId: null },
			}),
		);
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer, registered synchronously (before content.js fires
	// the initial ytb:navigate).
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', () => {
		if (!YTB.isContextActive()) return;
		const wasHome = onHome;
		onHome = isHomePath();
		// A NEW visit to the home route reopens the Feed like reopening a chat:
		// the reveal window resets to the newest page. Same-page navigates (e.g.
		// commitCode's poll nudge) keep the viewer's window.
		if (onHome && !wasHome) resetFeedWindow();
		ensureSection();
	});

	document.addEventListener('ytb:mutation', () => {
		if (!YTB.isContextActive()) return;
		// YouTube rebuilds the browse contents lazily (and sometimes replaces
		// them wholesale); keep the section present without re-rendering it.
		ensureSection();
	});

	document.addEventListener('ytb:room-data', async (event) => {
		if (!YTB.isContextActive()) return;
		const detail = (event && event.detail) || null;
		myClientId = (detail && detail.myClientId) || myClientId;

		// Connection Lost (PRD #137) only applies once there is a Room Code: an
		// Unpaired broadcast never carries the flag, so the Create/Join prompt is
		// untouched by an unreachable backend.
		connectionLost = Boolean(detail && detail.roomCode && detail.connectionLost);

		// A failed Room read is not truth: retain the last-known detail so the
		// Feed and the Recommended-for-you grid stay exactly as last rendered
		// instead of being rebuilt from the failure's empty arrays. Only a read
		// for the SAME Room retains — pairing into a different Room mid-outage
		// must not keep showing the old Room's content. (`locked` rides a
		// successful read, so it always replaces.)
		const failedRead = Boolean(detail && detail.roomCode && !detail.ok && !detail.locked);
		if (!(failedRead && lastDetail && lastDetail.roomCode === detail.roomCode)) {
			lastDetail = detail;
		}

		// Load this Room's persisted Dismissals before rendering the grid. On a
		// Room switch start fresh; otherwise merge, so a just-clicked Dismiss
		// whose storage write is still in flight cannot flicker back.
		const code = (lastDetail && lastDetail.roomCode) || '';
		if (code !== dismissedRoom) {
			dismissedIds = new Set();
			dismissedRoom = code;
			resetFeedWindow(); // a Room Code change reopens the Feed fresh
		}
		if (code) {
			const persisted = await YTB.dismissedVideoIds(code);
			if (dismissedRoom !== code) return; // switched Rooms mid-read
			for (const videoId of persisted) dismissedIds.add(videoId);
		}

		const section = ensureSection();
		if (section) render(section);
	});

	// The Room Home Toggle (home-toggle.js) persisted a flip: remove the
	// section outright, or re-inject and render it from the latest Room data.
	document.addEventListener('ytb:home-section-visibility', (event) => {
		if (!YTB.isContextActive()) return;
		hiddenPref = Boolean(event.detail && event.detail.hidden);
		applyVisibility();
	});

	// The same preference can now also flip in the popup's Settings view; the
	// storage change is the only signal that reaches this tab, so follow it
	// live too (the guide-toggle path above also lands here — idempotent).
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.homeSectionHidden || !YTB.isContextActive()) return;
		hiddenPref = changes.homeSectionHidden.newValue === true;
		applyVisibility();
	});

	// A Buddy Color re-assignment (issue #115): restyle the stamped Room Feed
	// author names in place from shared.js's refreshed cache. Deliberately NOT a
	// re-render — that would disturb the Feed's scroll position and its Show
	// more reveal state for a pure color change.
	document.addEventListener('ytb:buddy-colors', () => {
		if (!YTB.isContextActive()) return;
		const section = document.getElementById(SECTION_ID);
		if (!section) return;
		for (const span of section.querySelectorAll('[data-ytb-color-cid]')) {
			span.style.color = YTB.buddyTextColor(span.dataset.ytbColorCid);
		}
	});

	// Re-gate the section after a visibility flip: gone while hidden, freshly
	// injected AND rendered from the latest Room data when re-shown.
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
        padding: 10px 14px 12px;
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
      /* The title takes the slack so the Room Code and the close control sit
         together at the right edge, with or without a Room Code present. */
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
        padding: 6px 8px;
        border-radius: 12px;
        background: var(--ytb-surface-tint);
      }
      #${SECTION_ID} .ytb-hs-day {
        margin: 6px 0 2px;
        text-align: center;
        font-size: 10px; font-weight: 600;
        color: var(--ytb-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-day:first-child { margin-top: 0; }
      /* Show more: inline at the top of the scrollback, above the topmost day
         divider; scrolls with the content (not sticky) and adds no height to
         the section — the scroll region's max-height is unchanged. */
      #${SECTION_ID} .ytb-hs-more {
        display: block;
        width: 100%;
        margin: 0 0 4px;
        padding: 5px 8px;
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
      #${SECTION_ID} .ytb-hs-more:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ytb-ring); }
      #${SECTION_ID} .ytb-hs-item { margin: 3px 0; overflow-wrap: anywhere; }
      /* Only the quoted body is the link; hover/focus affordances live on it. */
      #${SECTION_ID} a.ytb-hs-text-link {
        color: inherit;
        text-decoration: none;
        border-radius: 6px;
        cursor: pointer;
        transition: background 120ms ease;
      }
      #${SECTION_ID} a.ytb-hs-text-link:hover {
        background: var(--ytb-accent-050);
        text-decoration: underline;
      }
      #${SECTION_ID} a.ytb-hs-text-link:focus-visible {
        outline: none;
        background: var(--ytb-accent-050);
        box-shadow: 0 0 0 2px var(--ytb-ring);
        text-decoration: underline;
      }
      #${SECTION_ID} .ytb-hs-author { font-weight: 700; }
      #${SECTION_ID} .ytb-hs-action { color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-context { color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-when { margin-left: 6px; font-size: 10px; color: var(--ytb-ink-muted); white-space: nowrap; }
      #${SECTION_ID} .ytb-hs-system { font-size: 11px; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link {
        color: var(--ytb-accent-800);
        font-weight: 600;
        text-decoration: none;
      }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:hover,
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:focus-visible { text-decoration: underline; }
      /* A struck System Message (superseded or un-recommended; per-Event —
         ADR-0007): strike the whole sentence, leaving the timestamp legible.
         The title inside is plain text (no anchor is rendered on a struck
         line), so it simply inherits the line's muted color — no accent, no
         bold, no hover underline, no pointer. */
      #${SECTION_ID} .ytb-hs-struck > span { text-decoration: line-through; }
      /* Visually hidden, read by assistive tech: a struck row's
         "(no longer recommended)" suffix — a line-through alone conveys
         nothing to a screen reader. */
      #${SECTION_ID} .ytb-hs-sr {
        position: absolute;
        width: 1px; height: 1px;
        margin: -1px; padding: 0; border: 0;
        clip-path: inset(50%);
        overflow: hidden;
        white-space: nowrap;
      }
      #${SECTION_ID} .ytb-hs-empty { margin: 4px 0; font-size: 12px; color: var(--ytb-ink-muted); }
      /* Connection Lost (PRD #137): quiet and deemphasized — the retained
         content below stays the focus; this line just explains the staleness. */
      #${SECTION_ID} .ytb-hs-conn { margin: -4px 0 8px; font-size: 11px; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-pl-row {
        display: flex; gap: 10px;
        overflow-x: auto;
        padding-bottom: 4px;
      }
      #${SECTION_ID} .ytb-hs-card { position: relative; flex: 0 0 132px; width: 132px; }
      #${SECTION_ID} .ytb-hs-thumb { display: block; border-radius: 10px; overflow: hidden; }
      #${SECTION_ID} .ytb-hs-thumb img { display: block; width: 132px; height: 74px; object-fit: cover; }
      #${SECTION_ID} .ytb-hs-card-title {
        margin-top: 3px;
        font-size: 11px; font-weight: 600; line-height: 1.3;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        color: inherit; text-decoration: none;
      }
      #${SECTION_ID} .ytb-hs-card-title:hover,
      #${SECTION_ID} .ytb-hs-card-title:focus-visible { text-decoration: underline; }
      #${SECTION_ID} .ytb-hs-watched { margin-top: 1px; font-size: 10px; color: var(--ytb-ink-muted); }
      /* Dismiss control: a dark scrim + light glyph over the thumbnail image,
         kept theme-independent on purpose (like the Note UI's over-video
         treatments) so it stays legible on any frame — not a palette color. */
      /* 24x24 hit target around a 20px visual scrim (UA-005): the transparent
         border widens the button's box while background-clip keeps the dark
         circle at 20px, visually inset 3px from the corner as before. */
      #${SECTION_ID} .ytb-hs-remove {
        position: absolute; top: 1px; right: 1px;
        width: 24px; height: 24px;
        padding: 0; border: 2px solid transparent; border-radius: 12px;
        background: rgba(0, 0, 0, 0.65); background-clip: padding-box; color: #fff;
        font: 14px/1 Arial, sans-serif;
        cursor: pointer;
        opacity: 0;
        transition: opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #${SECTION_ID} .ytb-hs-card:hover .ytb-hs-remove,
      #${SECTION_ID} .ytb-hs-remove:focus-visible { opacity: 1; }
      #${SECTION_ID} .ytb-hs-remove:disabled { opacity: 0.4; cursor: default; }
      #${SECTION_ID} .ytb-hs-pair { display: flex; flex-direction: column; gap: 8px; }
      #${SECTION_ID} .ytb-hs-pitch { margin: 0; color: var(--ytb-ink-muted); }
      #${SECTION_ID} .ytb-hs-pair-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      /* One control height across the Create / input / Join row (UA-009): a
         shared line-height and a transparent border on the primary keep the
         three boxes equal; borders and the input well use the documented
         roles (line-strong borders, surface-sunk well). */
      #${SECTION_ID} .ytb-hs-btn {
        padding: 7px 14px;
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
        padding: 7px 10px;
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
      #${SECTION_ID} .ytb-hs-error { margin: 0; min-height: 16px; font-size: 12px; color: var(--ytb-danger-text); }
      @media (prefers-reduced-motion: reduce) {
        #${SECTION_ID} .ytb-hs-btn, #${SECTION_ID} .ytb-hs-remove, #${SECTION_ID} .ytb-hs-close, #${SECTION_ID} .ytb-hs-more { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
