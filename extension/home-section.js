// extension/home-section.js
//
// The Room Home Section (ADR-0005): a compact two-column panel injected at the
// top of the YouTube HOME page, above the recommendations grid (which shifts
// down). Left: the Room Feed — a chronological, chat-like feed of Replies to
// the viewer's Notes, @-mentions of the viewer, deemphasized recommend System
// Messages ("X recommended ..." to recipients, "You recommended ... to the
// Room" to the recommender; struck through once un-recommended), and Watch
// Notices ("X watched ...", shown to the recommender when a Buddy watches
// their pick), grouped under day dividers, newest at the bottom,
// auto-scrolled. On System Messages and Watch Notices only the quoted video
// title is a link (to the video's watch page).
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
// live via `ytb:home-section-visibility`. Pure consumer per ADR-0001:
// content.js emits
// ytb:navigate/ytb:mutation, renderer.js polls the Room and rebroadcasts every
// read as `ytb:room-data` — this file makes no reads of its own (the only
// writes are Create/Join and their presence assert; a Dismiss only touches
// chrome.storage.local).
//
// Styling extends the DESIGN.md system (apricot accent, warm neutrals, gentle
// motion) to this surface. The popup's bundled Nunito is not re-embedded here
// (a base64 font per content script is too heavy); the stack falls back to
// rounded system faces. Both YouTube themes are supported via html[dark].

(function () {
	'use strict';

	const SECTION_ID = 'ytb-home-section';
	const STYLE_ID = 'ytb-home-section-style';

	let lastDetail = null; // most recent ytb:room-data payload
	let onHome = false;
	let myClientId = null;
	let pendingPair = false; // one Create/Join request at a time
	// Room Home Toggle state: null until the stored preference has been read,
	// so the section never flashes in before a hide preference is known.
	let hiddenPref = null;
	let dismissedIds = new Set(); // this Room's local Dismissals (videoIds)
	let dismissedRoom = ''; // the Room Code dismissedIds belongs to

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
			body.append(buildFeedColumn(detail), buildRecommendedColumn(detail));
		}

		section.replaceChildren(head, body);

		// Chat order: keep the newest Feed items in view on every render.
		const scroll = section.querySelector('.ytb-hs-feed-scroll');
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	}

	// --- Room Feed (left column) ---

	function buildFeedColumn(detail) {
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

		if (groups.length === 0) {
			const empty = document.createElement('p');
			empty.className = 'ytb-hs-empty';
			empty.textContent = 'Nothing yet. Replies to your notes and @mentions of you land here.';
			scroll.append(empty);
			return column;
		}

		for (const group of groups) {
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
		return column;
	}

	function buildFeedRow(item, roster) {
		const record = item.reply || item.note;
		// The Note this row points at: the parent Note for a Reply or a
		// Reply-Mention, the Note itself for a Note-Mention. Absent (parent not in
		// this Room read) leaves the row non-clickable.
		const target = item.note;
		const canOpen = Boolean(target && target.videoId && target.id && Number.isFinite(Number(target.timestamp)));

		const row = document.createElement(canOpen ? 'a' : 'div');
		row.className = canOpen ? 'ytb-hs-item ytb-hs-item-link' : 'ytb-hs-item';
		if (canOpen) {
			const seconds = Math.max(0, Math.floor(Number(target.timestamp)));
			row.href = '/watch?v=' + encodeURIComponent(target.videoId) + '&t=' + seconds;
			// Record the open-target, then let the anchor navigate (SPA on YouTube,
			// full reload in tests) — notes.js opens the Expanded Note on arrival's
			// first Room read. No preventDefault: the anchor IS the navigation.
			row.addEventListener('click', () => {
				YTB.setPendingNoteOpen({ videoId: target.videoId, noteId: target.id });
			});
		}

		const author = document.createElement('span');
		author.className = 'ytb-hs-author';
		author.textContent = YTB.buddyName(record.clientId, record.name, roster);
		author.style.color = YTB.buddyColor(record.clientId);

		const action = document.createElement('span');
		action.className = 'ytb-hs-action';
		action.textContent = item.type === 'reply' ? ' replied to your note ' : ' mentioned you ';

		const body = document.createElement('span');
		body.className = 'ytb-hs-text';
		body.textContent = '"' + record.body + '"';

		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);

		row.append(author, action, body, when);
		return row;
	}

	// The quoted video title as a System Message / Watch Notice row's ONLY link
	// (CONTEXT.md Room Feed link rule) — the rest of the line stays plain
	// deemphasized text. Falls back to plain quoted text without a videoId.
	function buildTitleLink(videoId, title) {
		const label = '"' + (title || 'a video') + '"';
		if (!videoId) return document.createTextNode(label);
		const link = document.createElement('a');
		link.className = 'ytb-hs-title-link';
		link.href = '/watch?v=' + encodeURIComponent(videoId);
		link.textContent = label;
		return link;
	}

	// A recommendation System Message (ADR-0007 amendment): recipients see
	// 'Bob recommended "Title"', the recommender their own 'You recommended
	// "Title" to the Room'. Only the quoted title links to the video; the stored
	// event title survives an un-recommend, so it stays correct even after the
	// live Playlist Item is gone — buildFeed then flags the item `removed` and
	// the whole line renders struck through (no removal event exists).
	function buildSystemRow(item, roster) {
		const event = item.event;
		const row = document.createElement('div');
		row.className = 'ytb-hs-item ytb-hs-system' + (item.removed ? ' ytb-hs-struck' : '');
		const text = document.createElement('span');
		const title = buildTitleLink(event.videoId, event.title);
		if (item.own) text.append('You recommended ', title, ' to the Room');
		else text.append(YTB.mentionName(roster, event.actorClientId) + ' recommended ', title);
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
		text.append(YTB.buddyName(item.clientId, item.name, roster) + ' watched ', buildTitleLink(item.videoId, item.title));
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
		onHome = isHomePath();
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
		lastDetail = (event && event.detail) || null;
		myClientId = (lastDetail && lastDetail.myClientId) || myClientId;

		// Load this Room's persisted Dismissals before rendering the grid. On a
		// Room switch start fresh; otherwise merge, so a just-clicked Dismiss
		// whose storage write is still in flight cannot flicker back.
		const code = (lastDetail && lastDetail.roomCode) || '';
		if (code !== dismissedRoom) {
			dismissedIds = new Set();
			dismissedRoom = code;
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

	// Re-gate the section after a visibility flip: gone while hidden, freshly
	// injected AND rendered from the latest Room data when re-shown.
	function applyVisibility() {
		const section = ensureSection();
		if (section) render(section);
	}

	YTB.onContextInvalidated(() => {
		document.getElementById(SECTION_ID)?.remove();
	});

	/** Inject the section stylesheet once (light + html[dark] themes). */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      #${SECTION_ID} {
        --ytbhs-surface: #fffdfb;
        --ytbhs-tint: #fff3e9;
        --ytbhs-line: #ece1d6;
        --ytbhs-ink: #3a2e28;
        --ytbhs-ink-muted: #7a6656;
        --ytbhs-accent: #f6a96b;
        --ytbhs-accent-deep: #9e551f;
        box-sizing: border-box;
        margin: 12px 8px 4px;
        padding: 10px 14px 12px;
        border: 1px solid var(--ytbhs-line);
        border-radius: 16px;
        background: var(--ytbhs-surface);
        color: var(--ytbhs-ink);
        font-family: Nunito, ui-rounded, 'SF Pro Rounded', Roboto, system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.45;
      }
      html[dark] #${SECTION_ID} {
        --ytbhs-surface: #221c18;
        --ytbhs-tint: #2b241f;
        --ytbhs-line: #3d332c;
        --ytbhs-ink: #f4ece2;
        --ytbhs-ink-muted: #b3a091;
        --ytbhs-accent: #f6a96b;
        --ytbhs-accent-deep: #f8c79a;
      }
      #${SECTION_ID} .ytb-hs-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
      #${SECTION_ID} .ytb-hs-dot {
        align-self: center;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--ytbhs-accent);
      }
      #${SECTION_ID} .ytb-hs-title { margin: 0; font-size: 15px; font-weight: 800; color: var(--ytbhs-ink); }
      #${SECTION_ID} .ytb-hs-code { margin-left: auto; font-size: 13px; font-weight: 800; color: var(--ytbhs-accent-deep); }
      #${SECTION_ID} .ytb-hs-body { display: flex; gap: 12px; align-items: stretch; }
      #${SECTION_ID} .ytb-hs-feed { flex: 1 1 46%; min-width: 0; }
      #${SECTION_ID} .ytb-hs-playlist { flex: 1 1 54%; min-width: 0; }
      #${SECTION_ID} .ytb-hs-col-head {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 4px;
        font-size: 11px; font-weight: 600; color: var(--ytbhs-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-count { font-weight: 500; }
      #${SECTION_ID} .ytb-hs-feed-scroll {
        max-height: 148px;
        overflow-y: auto;
        padding: 6px 8px;
        border-radius: 12px;
        background: var(--ytbhs-tint);
      }
      #${SECTION_ID} .ytb-hs-day {
        margin: 6px 0 2px;
        text-align: center;
        font-size: 10px; font-weight: 600;
        color: var(--ytbhs-ink-muted);
      }
      #${SECTION_ID} .ytb-hs-day:first-child { margin-top: 0; }
      #${SECTION_ID} .ytb-hs-item { margin: 3px 0; overflow-wrap: anywhere; }
      #${SECTION_ID} a.ytb-hs-item-link {
        display: block;
        margin: 3px -6px;
        padding: 3px 6px;
        border-radius: 8px;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: background 120ms ease;
      }
      #${SECTION_ID} a.ytb-hs-item-link:hover { background: rgba(246, 169, 107, 0.16); }
      #${SECTION_ID} a.ytb-hs-item-link:focus-visible {
        outline: none;
        background: rgba(246, 169, 107, 0.16);
        box-shadow: 0 0 0 2px rgba(246, 169, 107, 0.55);
      }
      #${SECTION_ID} .ytb-hs-author { font-weight: 700; }
      #${SECTION_ID} .ytb-hs-action { color: var(--ytbhs-ink-muted); }
      #${SECTION_ID} .ytb-hs-when { margin-left: 6px; font-size: 10px; color: var(--ytbhs-ink-muted); white-space: nowrap; }
      #${SECTION_ID} .ytb-hs-system { font-size: 11px; color: var(--ytbhs-ink-muted); }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link {
        color: var(--ytbhs-accent-deep);
        font-weight: 600;
        text-decoration: none;
      }
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:hover,
      #${SECTION_ID} .ytb-hs-system a.ytb-hs-title-link:focus-visible { text-decoration: underline; }
      /* An un-recommended System Message: strike the sentence (the title link
         inherits the ancestor's line-through per CSS decoration propagation),
         leaving the timestamp legible. */
      #${SECTION_ID} .ytb-hs-struck > span { text-decoration: line-through; }
      #${SECTION_ID} .ytb-hs-empty { margin: 4px 0; font-size: 12px; color: var(--ytbhs-ink-muted); }
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
      #${SECTION_ID} .ytb-hs-watched { margin-top: 1px; font-size: 10px; color: var(--ytbhs-ink-muted); }
      #${SECTION_ID} .ytb-hs-remove {
        position: absolute; top: 3px; right: 3px;
        width: 20px; height: 20px;
        padding: 0; border: 0; border-radius: 10px;
        background: rgba(0, 0, 0, 0.65); color: #fff;
        font: 14px/1 Arial, sans-serif;
        cursor: pointer;
        opacity: 0;
        transition: opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #${SECTION_ID} .ytb-hs-card:hover .ytb-hs-remove,
      #${SECTION_ID} .ytb-hs-remove:focus-visible { opacity: 1; }
      #${SECTION_ID} .ytb-hs-remove:disabled { opacity: 0.4; cursor: default; }
      #${SECTION_ID} .ytb-hs-pair { display: flex; flex-direction: column; gap: 8px; }
      #${SECTION_ID} .ytb-hs-pitch { margin: 0; color: var(--ytbhs-ink-muted); }
      #${SECTION_ID} .ytb-hs-pair-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      #${SECTION_ID} .ytb-hs-btn {
        padding: 7px 14px;
        border: 1px solid var(--ytbhs-line);
        border-radius: 12px;
        background: var(--ytbhs-tint);
        color: var(--ytbhs-ink);
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        transition: transform 140ms cubic-bezier(0.34, 1.3, 0.64, 1), background 140ms;
      }
      #${SECTION_ID} .ytb-hs-btn:active { transform: scale(0.97); }
      #${SECTION_ID} .ytb-hs-btn-primary { border: 0; background: var(--ytbhs-accent); color: #3a2e28; }
      #${SECTION_ID} .ytb-hs-input {
        min-width: 190px;
        padding: 7px 10px;
        border: 1px solid var(--ytbhs-line);
        border-radius: 8px;
        background: var(--ytbhs-surface);
        color: var(--ytbhs-ink);
        font-family: inherit;
        font-size: 13px;
        line-height: 1.2;
      }
      #${SECTION_ID} .ytb-hs-input:focus { outline: none; border-color: var(--ytbhs-accent); box-shadow: 0 0 0 3px rgba(246, 169, 107, 0.35); }
      #${SECTION_ID} .ytb-hs-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(246, 169, 107, 0.55); }
      #${SECTION_ID} .ytb-hs-error { margin: 0; min-height: 16px; font-size: 12px; color: #c0392b; }
      @media (prefers-reduced-motion: reduce) {
        #${SECTION_ID} .ytb-hs-btn, #${SECTION_ID} .ytb-hs-remove { transition: none; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
