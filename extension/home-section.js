// extension/home-section.js
//
// The Room Home Section (ADR-0005): a compact two-column panel injected at the
// top of the YouTube HOME page, above the recommendations grid (which shifts
// down). Left: the Room Feed — a chronological, chat-like feed of Replies to
// the viewer's Notes, @-mentions of the viewer, and deemphasized System
// Messages for Shared Playlist changes, grouped under day dividers, newest at
// the bottom, auto-scrolled. Right: the Shared Playlist — one Room-level list
// of up to 30 videos as a horizontal thumbnail row, each with a live
// "Watched by ..." attribution and a remove control. Unpaired installs get a
// compact Create/Join prompt (same YTB / YTBRoomCode calls as the popup, which
// stays the source of truth for identity and Room membership).
//
// Strictly gated to the home route ('/'); re-injected after SPA navigations
// back to home. Pure consumer per ADR-0001: content.js emits
// ytb:navigate/ytb:mutation, renderer.js polls the Room and rebroadcasts every
// read as `ytb:room-data` — this file makes no reads of its own (the only
// writes are Create/Join, playlist removal, and their presence assert).
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

	injectStyle();

	function isHomePath() {
		return location.pathname === '/';
	}

	// ---------------------------------------------------------------------------
	// Injection: above the home grid, re-attempted on mutations until it lands.
	// ---------------------------------------------------------------------------

	function ensureSection() {
		if (!YTB.isContextActive()) return null;
		if (!onHome) {
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
			body.append(buildFeedColumn(detail), buildPlaylistColumn(detail));
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
		const titles = new Map((detail.playlist || []).map((item) => [item.videoId, item.title]));
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
				scroll.append(item.type === 'system' ? buildSystemRow(item, roster, titles) : buildFeedRow(item, roster));
			}
		}
		return column;
	}

	function buildFeedRow(item, roster) {
		const record = item.reply || item.note;
		const row = document.createElement('div');
		row.className = 'ytb-hs-item';

		const author = document.createElement('span');
		author.className = 'ytb-hs-author';
		author.textContent = YTB.buddyName(record.clientId, record.name);
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

	function buildSystemRow(item, roster, titles) {
		const event = item.event;
		const row = document.createElement('div');
		row.className = 'ytb-hs-item ytb-hs-system';
		const actor = event.actorClientId === myClientId ? 'You' : YTB.mentionName(roster, event.actorClientId);
		// A removed video's Playlist Item is gone, so its title may be unknown.
		const title = titles.get(event.videoId) || 'a video';
		const verb = event.type === 'removed' ? ' removed ' : ' added ';
		const tail = event.type === 'removed' ? ' from the playlist' : ' to the playlist';
		const text = document.createElement('span');
		text.textContent = actor + verb + '"' + title + '"' + tail;
		const when = document.createElement('time');
		when.className = 'ytb-hs-when';
		when.textContent = YTB.relativeTime(item.at);
		row.append(text, when);
		return row;
	}

	// --- Shared Playlist (right column) ---

	function buildPlaylistColumn(detail) {
		const column = document.createElement('section');
		column.className = 'ytb-hs-playlist';
		column.setAttribute('aria-label', 'Shared Playlist');

		const head = document.createElement('div');
		head.className = 'ytb-hs-col-head';
		head.textContent = 'Shared Playlist';
		const count = document.createElement('span');
		count.className = 'ytb-hs-count';
		count.textContent = (detail.playlist || []).length + ' / ' + YTB.MAX_PLAYLIST_ITEMS;
		head.append(count);
		column.append(head);

		const items = [...(detail.playlist || [])].sort((a, b) => b.addedAt - a.addedAt);
		if (items.length === 0) {
			const empty = document.createElement('p');
			empty.className = 'ytb-hs-empty';
			empty.textContent = 'No videos yet. Add one with the Buddy Room button on a video, or from a thumbnail menu.';
			column.append(empty);
			return column;
		}

		const row = document.createElement('div');
		row.className = 'ytb-hs-pl-row';
		for (const item of items) row.append(buildPlaylistCard(item, detail));
		column.append(row);
		return column;
	}

	function buildPlaylistCard(item, detail) {
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

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'ytb-hs-remove';
		remove.textContent = '×';
		remove.title = 'Remove from Shared Playlist';
		remove.setAttribute('aria-label', 'Remove "' + item.title + '" from the Shared Playlist');
		remove.addEventListener('click', async (event) => {
			event.preventDefault();
			event.stopPropagation();
			remove.disabled = true;
			const clientId = myClientId || (await YTB.ensureClientId());
			const result = await YTB.deletePlaylistItem({ clientId, videoId: item.videoId });
			if (result.ok && lastDetail) {
				// Optimistic local removal; the next Room poll confirms.
				lastDetail.playlist = (lastDetail.playlist || []).filter((entry) => entry.videoId !== item.videoId);
				render();
			} else {
				remove.disabled = false;
			}
		});

		const title = document.createElement('div');
		title.className = 'ytb-hs-card-title';
		title.textContent = item.title;

		const watched = document.createElement('div');
		watched.className = 'ytb-hs-watched';
		const label = YTB.watchedByLabel(detail.progress, item.videoId, myClientId);
		watched.textContent = label ? 'Watched by ' + label : 'New to the Room';

		card.append(link, remove, title, watched);
		return card;
	}

	// --- Unpaired: compact Create/Join prompt ---

	function buildPairPrompt() {
		const wrap = document.createElement('div');
		wrap.className = 'ytb-hs-pair';

		const pitch = document.createElement('p');
		pitch.className = 'ytb-hs-pitch';
		pitch.textContent = 'Watch together, apart. Share progress, notes, and a playlist with up to four friends.';

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
		document.dispatchEvent(new CustomEvent('ytb:navigate', { detail: { url: location.href, videoId: null } }));
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

	document.addEventListener('ytb:room-data', (event) => {
		if (!YTB.isContextActive()) return;
		lastDetail = (event && event.detail) || null;
		myClientId = (lastDetail && lastDetail.myClientId) || myClientId;
		const section = ensureSection();
		if (section) render(section);
	});

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
      #${SECTION_ID} .ytb-hs-author { font-weight: 700; }
      #${SECTION_ID} .ytb-hs-action { color: var(--ytbhs-ink-muted); }
      #${SECTION_ID} .ytb-hs-when { margin-left: 6px; font-size: 10px; color: var(--ytbhs-ink-muted); white-space: nowrap; }
      #${SECTION_ID} .ytb-hs-system { font-size: 11px; color: var(--ytbhs-ink-muted); }
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
      }
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
