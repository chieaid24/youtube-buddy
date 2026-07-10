// extension/notes.js
//
// ALL Note & Reaction presentation on the watch page:
//   - Video Timeline dots (text Notes, Reactions, locked Spoilers) floating
//     just above the progress bar, each at its exact timestamp fraction —
//     co-timed dots simply overlap, and every dot swallows the pointer events
//     it receives so YouTube never pops its storyboard thumbnail or time pill
//     behind a Note Preview;
//   - hover/focus Note Previews (two-line body, author beneath, Reply count,
//     corner timestamp) reachable across a transparent hover bridge;
//   - the Expanded Note: a pinned panel opened by clicking ANY Note Dot or Note
//     Preview (text, Reaction, or locked Spoiler) — activation never seeks. It
//     has three variants: a text Note's full conversation (Replies, a Reply
//     composer with paper-plane send, the author-only delete), a Reaction's
//     read-only emoji + author, and a locked Spoiler's masked "Spoiler" body
//     (no conversation, composer, or delete until it unlocks). Every variant
//     pins the Note's video timestamp in its top-right corner and offers the
//     one "Go here" seek-and-play control — omitted when the paused playhead is
//     already within ~2s of the moment;
//   - Playback Notifications: note cards (~4s, clickable) and animated
//     Reaction bursts (~2s, non-interactive) on every NATURAL forward
//     crossing — rewind-and-replay triggers again, direct seeks stay silent.
//     They render at the viewer's Notification Position (one of four player
//     edges, default bottom; live via chrome.storage.onChanged).
//   - Unseen pulses (ADR-0010): a Note Dot carrying an Unseen Mention or
//     Reply pulses an apricot halo until Acknowledged — by hovering the dot,
//     opening its Expanded Note, or a natural forward crossing. The derivation
//     is pure (YTB.unseenNoteIds / YTB.acknowledgeTargets); the seen set is
//     private, per install, Room-scoped chrome.storage.local (YTB.markSeen /
//     YTB.pruneSeen) and never reaches the backend.
//   - Notes Visibility ("Notes off"): while the notesHidden setting is on,
//     this file renders NOTHING — no dots, previews, panels, or Playback
//     Notifications (composer.js removes the + button) — and Acknowledges
//     nothing — updating live.
//
// Styling consumes the namespaced --ytb-* tokens + 'YTB Rounded' face injected
// by theme.js (the shared on-video apricot foundation); theme.js also isolates
// keystrokes in the Reply textarea from YouTube's player hotkeys by swallowing
// real key events and re-dispatching `ytb:keydown` (detail.original carries
// the key state), which the Reply composer listens for below.
//
// Pure consumer per ADR-0001: content.js owns navigation/mutation events and
// renderer.js owns Room polling (rebroadcast here as `ytb:room-data`). The only
// network traffic originating here is the focused conversation poll (every 5s
// WHILE an Expanded Note is open) and Reply/delete writes. composer.js hands
// freshly posted records over via `ytb:note-posted` so the current Video
// Timeline reconciles immediately, without waiting for any poll.

(function () {
	'use strict';

	const DOT_CLASS = 'ytb-note-dot';
	const DOT_TEXT_CLASS = 'ytb-note-dot-text';
	const DOT_REACTION_CLASS = 'ytb-note-dot-reaction';
	const DOT_LOCKED_CLASS = 'ytb-note-dot-locked';
	const DOT_OPEN_CLASS = 'ytb-note-dot-open'; // suppresses the open Note's own preview
	const DOT_UNSEEN_CLASS = 'ytb-note-dot-unseen'; // pulses the apricot halo (ADR-0010)
	const PREVIEW_CLASS = 'ytb-note-preview';
	const PANEL_ID = 'ytb-note-panel';
	const ALERTS_ID = 'ytb-note-alerts';
	const STYLE_ID = 'ytb-notes-style';

	const CONVERSATION_POLL_MS = 5000; // focused Expanded Note freshness
	const LABEL_REFRESH_MS = 30_000; // "Posted 8 min ago" recomputation
	const NOTE_CARD_MS = 4000; // text-note Playback Notification lifetime
	const REACTION_BURST_MS = 2000; // Reaction float-and-fade lifetime
	// Concurrent crossings enter one-per-beat on this stagger, in timestamp order,
	// instead of all at once — a staggered entrance, not serialization (each
	// notification's own lifetime still starts at its own entrance).
	const ENTRANCE_STAGGER_MS = 100;
	// Steps larger than this between timeupdates are seeks, not playback.
	const NATURAL_DELTA_SECONDS = 2;

	// --- state ---
	let myClientId = null;
	let activeRoomCode = '';
	let notesByVideoId = new Map(); // videoId -> Note[] (mine and Buddies')
	let repliesByNoteId = new Map(); // noteId -> Reply[] oldest-first (Room reads + local appends)
	let roster = []; // full Room roster (incl. me), for Room-unique Buddy labels
	let currentVideoId = null;
	let lastPlaybackTime = null; // previous timeupdate, for natural crossings
	// Crossed Notes wait here and drain one-per-beat (ENTRANCE_STAGGER_MS); the
	// timer is non-null exactly while a drain is in flight.
	let alertQueue = [];
	let alertDrainTimer = null;
	// Unseen state (ADR-0010). `seenSet` mirrors the Room's persisted seen list
	// (loaded + pruned on each Room read); `unseenDotIds` is the derived set of
	// Note ids whose dots pulse, kept synchronous so renderDots (which runs on
	// every timeupdate) never awaits storage.
	let seenSet = new Set();
	let unseenDotIds = new Set();

	// Expanded Note state. `pauseLease` records whether OPENING (the first panel
	// in a chain of replacements) paused a playing video: an outside dismissal
	// then resumes; a video that was already paused stays paused.
	let openNote = null;
	let pauseLease = false;
	let pollTimer = null;
	let labelTimer = null;
	let pendingReply = false;
	let pendingDelete = false;
	// A Room Feed reply/mention row (home-section.js) recorded a Note to open on
	// arrival; consumed on the first Room read for its video. Loaded once (covers
	// a full reload) and mirrored live from storage (covers SPA nav, where this
	// script stays alive) — see below.
	let pendingNoteOpen = null;
	// Timestamp until which a `play` is treated as watch-page load churn (autoplay
	// settling in after a Room Feed row opened this Note) instead of a deliberate
	// resume: within it the panel is kept open and the video re-paused. Armed only
	// by a pending open; a real navigation clears it. See YTB.panelPlayAction.
	let pendingOpenGuardUntil = 0;

	// Settings (live via chrome.storage.onChanged below).
	let notesHidden = false; // Notes Visibility off: zero Note UI on the player
	let notificationPosition = 'bottom'; // Playback Notification edge

	injectStyle();

	YTB.getSettings().then((settings) => {
		notesHidden = settings.notesHidden;
		notificationPosition = settings.notificationPosition;
		renderDots();
	});

	// Read any target a Room Feed row left before this script (re)loaded, then
	// consume it once its Room read lands. On SPA nav this script never reloads,
	// so the onChanged mirror below picks up the write instead.
	YTB.getPendingNoteOpen().then((target) => {
		pendingNoteOpen = target;
		tryOpenPending();
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !YTB.isContextActive()) return;
		if (changes.notesHidden) {
			notesHidden = changes.notesHidden.newValue === true;
			if (notesHidden) {
				dismissPanel(); // dismissal semantics: lease-aware resume
				resetAlerts(); // clear on-screen + queued, cancel the drain
			}
			renderDots(); // reconciles to zero dots when hidden, back when shown
		}
		if (changes.notificationPosition) {
			const edge = changes.notificationPosition.newValue;
			notificationPosition = YTB.NOTIFICATION_EDGES.includes(edge) ? edge : 'bottom';
			const wrap = document.getElementById(ALERTS_ID);
			const host = player();
			if (wrap && host) applyAlertsPosition(wrap, host); // live re-anchor
		}
		if ('pendingNoteOpen' in changes) {
			const next = changes.pendingNoteOpen.newValue;
			pendingNoteOpen = next && next.videoId && next.noteId ? next : null;
			tryOpenPending();
		}
	});

	// ---------------------------------------------------------------------------
	// Data intake: Room broadcasts, immediate post reconciliation.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:room-data', (event) => {
		const detail = (event && event.detail) || {};
		myClientId = detail.myClientId || myClientId;
		activeRoomCode = detail.roomCode || '';
		roster = YTB.roomRoster(detail);

		// Reconcile by server id: a locally inserted Note and the next Room read
		// can never duplicate because both index into these maps by id.
		const nextNotes = new Map();
		for (const note of detail.notes || []) {
			if (!note || !note.id || !note.videoId) continue;
			if (!nextNotes.has(note.videoId)) nextNotes.set(note.videoId, []);
			nextNotes.get(note.videoId).push(note);
		}
		notesByVideoId = nextNotes;

		const nextReplies = new Map();
		for (const reply of detail.replies || []) {
			if (!reply || !reply.id || !reply.noteId) continue;
			if (!nextReplies.has(reply.noteId)) nextReplies.set(reply.noteId, []);
			nextReplies.get(reply.noteId).push(reply);
		}
		for (const list of nextReplies.values()) {
			list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
		}
		repliesByNoteId = nextReplies;
		syncSeenState(detail); // async: dots may render below before the pulse set lands
		renderDots();
		tryOpenPending(); // a Room Feed row may have asked to open a Note here
	});

	// ---------------------------------------------------------------------------
	// Unseen state (ADR-0010): the pulse set and the three Acknowledge triggers.
	// ---------------------------------------------------------------------------

	/** The Room read shape the pure Unseen helpers take, rebuilt from the maps so
	 * local appends (ytb:note-posted, appendLocalReply, conversation polls) are
	 * reflected without waiting for the next Room poll. */
	function currentRecords() {
		return {
			notes: [...notesByVideoId.values()].flat(),
			replies: [...repliesByNoteId.values()].flat(),
		};
	}

	/** Recompute which dots pulse from the current maps + seen set. */
	function recomputeUnseen() {
		unseenDotIds = myClientId ? new Set(YTB.unseenNoteIds(currentRecords(), myClientId, seenSet)) : new Set();
	}

	/**
	 * Reload (and prune) the Room's persisted seen set after a Room read, then
	 * derive the pulse set. Pruning only follows a SUCCESSFUL read — a failed
	 * GET broadcasts empty arrays, and pruning against those would wipe the set
	 * and resurrect every Acknowledged pulse. An open Expanded Note Acknowledges
	 * anything the read just added beneath it: its conversation is on screen.
	 */
	async function syncSeenState(detail) {
		const code = activeRoomCode;
		if (!code || !myClientId) {
			seenSet = new Set();
			unseenDotIds = new Set();
			return;
		}
		let kept;
		if (detail.ok) {
			const live = [];
			for (const note of detail.notes || []) if (note && note.id) live.push(note.id);
			for (const reply of detail.replies || []) if (reply && reply.id) live.push(reply.id);
			kept = await YTB.pruneSeen(code, live);
		} else {
			kept = await YTB.seenIds(code);
		}
		if (!YTB.isContextActive() || activeRoomCode !== code) return; // Room changed while awaiting
		seenSet = new Set(kept);
		recomputeUnseen();
		if (openNote) acknowledgeDot(openNote.id);
		renderDots();
	}

	/**
	 * Acknowledge one Note Dot: clear EVERY Unseen item anchored to it at once —
	 * the Mention and all Unseen Replies beneath it — and stop its pulse for
	 * good. Idempotent and cheap on a dot with nothing Unseen (the common case:
	 * every hover and crossing routes through here). While Notes Visibility is
	 * off nothing renders and nothing is Acknowledged.
	 */
	function acknowledgeDot(noteId) {
		if (notesHidden || !noteId || !unseenDotIds.has(noteId)) return;
		const ids = YTB.acknowledgeTargets(currentRecords(), myClientId, noteId);
		if (ids.length === 0) return;
		for (const id of ids) seenSet.add(id);
		unseenDotIds.delete(noteId);
		YTB.markSeen(activeRoomCode, ids); // best-effort persist; the in-memory set already stopped the pulse
		renderDots();
	}

	/**
	 * If a Room Feed row queued a Note to open and this video now carries it, open
	 * the Expanded Note and clear the slot. Leaves the slot for a later Room read
	 * when the Note has not loaded yet (a mismatched video, or a poll that predates
	 * it); an expired or vanished target is dropped so it never pops on a later
	 * visit.
	 */
	function tryOpenPending() {
		const target = pendingNoteOpen;
		if (!target) return;
		if (Date.now() - (Number(target.at) || 0) > YTB.PENDING_NOTE_OPEN_TTL_MS) {
			clearPendingOpen();
			return;
		}
		if (target.videoId !== currentVideoId) return; // still en route to the video
		if (notesHidden) {
			clearPendingOpen(); // Notes are off: honor the toggle, drop the request
			return;
		}
		const note = (notesByVideoId.get(currentVideoId) || []).find((candidate) => candidate.id === target.noteId);
		if (!note) return; // not in this read yet — retry on the next one (until TTL)
		clearPendingOpen();
		// Arm the load-churn grace BEFORE opening: the watch page is still settling
		// on arrival, and its autoplay `play` must re-pause and keep this panel open
		// rather than dismiss it (the whole point of the Feed handshake).
		pendingOpenGuardUntil = Date.now() + YTB.PANEL_LOAD_GRACE_MS;
		openPanel(note);
	}

	function clearPendingOpen() {
		pendingNoteOpen = null;
		YTB.clearPendingNoteOpen();
	}

	// composer.js posted a Note/Reaction: insert the complete server record into
	// the active Video Timeline immediately — no waiting for the 60s Room poll.
	document.addEventListener('ytb:note-posted', (event) => {
		const note = event.detail && event.detail.note;
		if (!note || !note.id || !note.videoId) return;
		myClientId = myClientId || note.clientId;
		const list = notesByVideoId.get(note.videoId) || [];
		if (!list.some((existing) => existing.id === note.id)) list.push(note);
		notesByVideoId.set(note.videoId, list);
		renderDots();
	});

	// ---------------------------------------------------------------------------
	// Video Timeline dots + Note Previews.
	// ---------------------------------------------------------------------------

	function notesForCurrentVideo() {
		return (currentVideoId && notesByVideoId.get(currentVideoId)) || [];
	}

	function repliesFor(noteId) {
		return repliesByNoteId.get(noteId) || [];
	}

	function replyCount(noteId) {
		return repliesFor(noteId).length;
	}

	/** Reconcile all Note dots for the active video against the progress bar. */
	function renderDots() {
		const bar = document.querySelector('.ytp-progress-bar');
		const video = document.querySelector('video');
		if (!bar) return; // player not built yet — a later ytb:mutation retries

		const duration = video ? Number(video.duration) : NaN;
		const playhead = video ? Number(video.currentTime) : 0;
		const desired = new Map(); // id -> { note, locked, fraction }
		// Notes off: desired stays empty, so the reconciliation below strips
		// every existing dot (and re-grows them all when turned back on).
		if (!notesHidden && Number.isFinite(duration) && duration > 0) {
			for (const note of notesForCurrentVideo()) {
				const timestamp = Number(note.timestamp);
				if (!Number.isFinite(timestamp)) continue;
				desired.set(note.id, {
					note,
					// Spoiler state follows the viewer's playhead and can relock when
					// the video is revisited from an earlier point.
					locked: Boolean(note.spoiler) && playhead < timestamp,
					// The dot's exact moment on the bar. Never displaced: co-timed
					// dots overlap (truth of position beats legibility).
					fraction: Math.max(0, Math.min(1, timestamp / duration)),
				});
			}
		}

		const existing = new Map();
		for (const dot of bar.querySelectorAll(':scope > .' + DOT_CLASS)) {
			const id = dot.dataset.ytbNoteId;
			if (desired.has(id)) existing.set(id, dot);
			else dot.remove();
		}
		if (desired.size === 0) return;
		if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';

		for (const [id, { note, locked, fraction }] of desired) {
			let dot = existing.get(id);
			if (!dot) {
				dot = document.createElement('button');
				dot.type = 'button';
				dot.className = DOT_CLASS;
				dot.dataset.ytbNoteId = id;
				const preview = dot.appendChild(document.createElement('div'));
				preview.className = PREVIEW_CLASS;
				// Never let the player interpret a dot press as a seek. Clicking the
				// dot OR its Note Preview opens that Note's Expanded Note (the click
				// itself never seeks — Go here inside the panel is the only seek).
				// The hover family is swallowed too, so a hovered dot never leaks
				// into the bar beneath it: YouTube pops no storyboard thumbnail and
				// no time pill behind a Note Preview.
				for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mousemove', 'mouseover']) {
					dot.addEventListener(type, (e) => e.stopPropagation());
				}
				dot.addEventListener('click', (e) => {
					e.stopPropagation();
					e.preventDefault();
					onDotActivate(dot);
				});
				// Hovering an Unseen dot Acknowledges it (ADR-0010) — the Note Preview
				// that hover opens is the eye-catch the pulse asked for; keyboard
				// focus, which opens the same preview, Acknowledges identically.
				// (mouseenter never bubbles, so it needs no swallowing above.)
				dot.addEventListener('mouseenter', () => acknowledgeDot(dot.dataset.ytbNoteId));
				dot.addEventListener('focus', () => acknowledgeDot(dot.dataset.ytbNoteId));
				bar.appendChild(dot);
			}
			dot.style.left = (fraction * 100).toFixed(3) + '%';
			dot.style.background = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);
			// The open Note's own hover preview is redundant next to its panel.
			dot.classList.toggle(DOT_OPEN_CLASS, Boolean(openNote) && openNote.id === id);
			// Unseen dots pulse until Acknowledged (ADR-0010). Layout-free by
			// construction: the halo is box-shadow only, so neighbouring dots —
			// which sit at their true, possibly overlapping fractions — are never
			// displaced.
			dot.classList.toggle(DOT_UNSEEN_CLASS, unseenDotIds.has(id));

			const count = replyCount(id);
			const signature = JSON.stringify([locked, note.kind, note.clientId, note.name, note.body, count]);
			if (dot.dataset.ytbSig === signature) continue;
			dot.dataset.ytbSig = signature;

			const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster);
			const at = YTB.formatTime(note.timestamp);
			const isReaction = note.kind === 'emoji';
			dot.classList.toggle(DOT_LOCKED_CLASS, locked);
			dot.classList.toggle(DOT_REACTION_CLASS, isReaction && !locked);
			dot.classList.toggle(DOT_TEXT_CLASS, !isReaction && !locked);
			dot.setAttribute(
				'aria-label',
				locked
					? `Spoiler note at ${at}. Open note`
					: isReaction
						? `Reaction ${note.body} by ${who} at ${at}. Open note`
						: `Note by ${who} at ${at}. Open conversation`,
			);
			buildPreview(dot.querySelector('.' + PREVIEW_CLASS), note, who, locked, count);
		}
	}

	// Activating ANY Note Dot or Note Preview — text, Reaction, or locked
	// Spoiler — opens that Note's Expanded Note; the click itself never seeks or
	// changes playback (Go here inside the panel is the only seek). The routing
	// is the pure YTB.dotActivation ("always open"); this stays the thin executor.
	function onDotActivate(dot) {
		const note = findNote(dot.dataset.ytbNoteId);
		if (!note) return;
		if (YTB.dotActivation(note).action === 'open') openPanel(note);
	}

	/**
	 * Go here: seek to roughly one second before the Note and resume playback,
	 * so the Note reveals through its own Playback Notification on the natural
	 * forward crossing. Local playback control only (no write), so it works
	 * regardless of Sharing. If an Expanded Note is open, the resulting 'play'
	 * event closes it via the existing manual-resume path.
	 */
	function goHere(note) {
		const video = document.querySelector('video');
		if (!video) return;
		video.currentTime = YTB.goHereTarget(Number(note.timestamp));
		video.play();
	}

	function findNote(id) {
		for (const notes of notesByVideoId.values()) {
			const match = notes.find((note) => note.id === id);
			if (match) return match;
		}
		return null;
	}

	function buildPreview(preview, note, who, locked, count) {
		preview.replaceChildren();
		preview.classList.toggle('ytb-preview-reaction', note.kind === 'emoji' && !locked);
		// The Note's video timestamp, pinned in the top-right corner (a hovered
		// dot swallows the hover, so YouTube shows no time pill of its own).
		const time = document.createElement('div');
		time.className = 'ytb-preview-time';
		time.textContent = '@' + YTB.formatTime(note.timestamp);
		preview.append(time);
		if (note.kind === 'emoji') {
			// Transparent treatment: the larger emoji with the author beneath it.
			const emoji = document.createElement('div');
			emoji.className = 'ytb-preview-emoji';
			emoji.textContent = note.body;
			const author = document.createElement('div');
			author.className = 'ytb-preview-emoji-author';
			author.textContent = who;
			if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
			preview.append(emoji, author);
			return;
		}
		// Text Note: the body is the hero, author small beneath it (own
		// authorship stays a neutral "You" — the stylesheet's muted default),
		// Reply count last. A locked Spoiler keeps this exact layout with the
		// body masked by a muted placeholder and the Reply count withheld until
		// the playhead crosses (only text Notes can be Spoilers).
		const body = document.createElement('div');
		body.className = locked ? 'ytb-preview-spoiler' : 'ytb-preview-body';
		body.textContent = locked ? 'Spoiler' : note.body;
		const author = document.createElement('div');
		author.className = 'ytb-preview-author';
		author.textContent = who;
		if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
		preview.append(body, author);
		if (!locked && count > 0) {
			const replies = document.createElement('div');
			replies.className = 'ytb-preview-replies';
			replies.textContent = count === 1 ? '1 reply' : `${count} replies`;
			preview.append(replies);
		}
	}

	// ---------------------------------------------------------------------------
	// Expanded Note: the pinned conversation panel.
	// ---------------------------------------------------------------------------

	function player() {
		return document.querySelector('#movie_player');
	}

	function dotFor(noteId) {
		const bar = document.querySelector('.ytp-progress-bar');
		if (!bar) return null;
		for (const dot of bar.querySelectorAll(':scope > .' + DOT_CLASS)) {
			if (dot.dataset.ytbNoteId === noteId) return dot;
		}
		return null;
	}

	/**
	 * The rectangle the Expanded Note should grow out of. A Note Preview is only on
	 * screen while its dot is hovered, so a hovered dot grows the panel from the
	 * preview card; keyboard activation (:focus-visible, no hover) — and any dot
	 * whose preview is already suppressed, or a programmatic open with no dot yet —
	 * grows it from the dot itself. Returns null when there is no dot to grow from.
	 */
	function panelGrowthSource(note) {
		const dot = dotFor(note.id);
		if (!dot) return null;
		const preview = dot.querySelector('.' + PREVIEW_CLASS);
		const fromPreview = preview && dot.matches(':hover') && !dot.classList.contains(DOT_OPEN_CLASS);
		return (fromPreview ? preview : dot).getBoundingClientRect();
	}

	function cssDurationMs(value, fallback) {
		const v = String(value).trim();
		if (v.endsWith('ms')) return parseFloat(v) || fallback;
		if (v.endsWith('s')) return parseFloat(v) * 1000 || fallback;
		return fallback;
	}

	/**
	 * Grow the freshly positioned Expanded Note out of `sourceRect` with a FLIP:
	 * the panel already sits at its final rect, so invert it onto the source rect
	 * (the Note Preview it replaced, or the dot) and play back to identity. The Web
	 * Animations API auto-clears the transform when it finishes, leaving no inline
	 * residue for a later positionPanel re-clamp. Durations and easings come from
	 * the --ytb-* motion tokens; prefers-reduced-motion collapses to an opacity-only
	 * fade (no transform), and a missing source falls back to a small scale-up.
	 */
	function flipPanelOpen(panel, sourceRect) {
		if (!panel.isConnected || typeof panel.animate !== 'function') return;
		const tokens = getComputedStyle(document.documentElement);
		const duration = cssDurationMs(tokens.getPropertyValue('--ytb-dur-base'), 200);
		const spring = tokens.getPropertyValue('--ytb-ease-spring').trim() || 'ease-out';

		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'linear' });
			return;
		}
		const final = panel.getBoundingClientRect();
		if (final.width < 1 || final.height < 1) return;
		if (!sourceRect || sourceRect.width < 1 || sourceRect.height < 1) {
			panel.animate(
				[
					{ opacity: 0, transform: 'scale(0.96) translateY(4px)' },
					{ opacity: 1, transform: 'none' },
				],
				{ duration, easing: spring },
			);
			return;
		}
		const dx = sourceRect.left - final.left;
		const dy = sourceRect.top - final.top;
		const sx = sourceRect.width / final.width;
		const sy = sourceRect.height / final.height;
		panel.animate(
			[
				{ transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
				{ transformOrigin: 'top left', transform: 'none', opacity: 1 },
			],
			{ duration, easing: spring },
		);
	}

	/**
	 * Open (or replace) the Expanded Note for `note`. Never seeks: it pauses at
	 * the viewer's current position. Only the FIRST open of a chain acquires the
	 * pause lease; replacing one panel with another keeps the video paused and
	 * the original lease.
	 */
	async function openPanel(note) {
		const host = player();
		if (!host || !note) return;
		// Where the Expanded Note grows FROM — captured before anything hides it:
		// the hovered Note Preview if one is on screen, else the bare dot.
		const sourceRect = panelGrowthSource(note);
		acknowledgeDot(note.id); // opening the Expanded Note Acknowledges its dot (ADR-0010)
		const video = document.querySelector('video');
		if (!document.getElementById(PANEL_ID)) {
			pauseLease = false;
			if (video && !video.paused) {
				pauseLease = true;
				video.pause();
			}
		}
		removePanel(); // replacement: drop the old panel, keep the lease

		openNote = note;
		const config = await YTB.getConfig();
		if (!YTB.isContextActive() || openNote !== note) return; // stopped/replaced while awaiting config

		// The playhead is stable now (opening paused it): it fixes both the panel
		// variant (a Spoiler's lock state) and whether Go here is near the moment.
		const playhead = video ? Number(video.currentTime) : Infinity;
		const variant = YTB.notePanelVariant(note, playhead);
		const panel = buildPanel(note, config, playhead, variant);
		host.appendChild(panel);
		positionPanel(panel);
		panel.focus();
		dotFor(note.id)?.classList.add(DOT_OPEN_CLASS); // hides its preview on the first FLIP frame
		flipPanelOpen(panel, sourceRect); // grow the panel out of that source rect

		// Only a text Note has a conversation to poll; read-only variants (Reaction,
		// locked Spoiler) just refresh their posted-time label.
		if (variant === 'text') startConversationPoll(panel);
		labelTimer = setInterval(() => refreshTimeLabels(panel), LABEL_REFRESH_MS);
	}

	/**
	 * Build the Expanded Note for `note` in the shape `variant` demands (chosen by
	 * YTB.notePanelVariant from the panel-open `playhead`):
	 * - 'text': the full conversation (Replies, composer, author-only delete);
	 * - 'reaction': read-only — the large emoji with its author beneath;
	 * - 'spoiler': read-only — a masked "Spoiler" body, conversation withheld.
	 * Every variant pins the corner timestamp and offers Go here unless the
	 * paused playhead already sits near the moment.
	 */
	function buildPanel(note, config, playhead, variant) {
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster);
		const panel = document.createElement('section');
		panel.id = PANEL_ID;
		panel.setAttribute('role', 'dialog');
		panel.setAttribute(
			'aria-label',
			variant === 'reaction' ? `Reaction by ${who}` : variant === 'spoiler' ? `Spoiler note by ${who}` : `Note by ${who}`,
		);
		panel.tabIndex = -1;

		// The Note's video timestamp, pinned in the top-right corner (matching the
		// Note Preview's corner timestamp), on every variant.
		const time = document.createElement('div');
		time.className = 'ytb-panel-time';
		time.textContent = '@' + YTB.formatTime(note.timestamp);
		panel.append(time);

		// Body area: the emoji + author for a Reaction, the masked placeholder for
		// a locked Spoiler, otherwise the text Note itself. The author renders in
		// the byline for text/Spoiler (beneath the emoji for a Reaction), staying a
		// neutral "You" for own authorship via the stylesheet's muted default.
		if (variant === 'reaction') {
			const emoji = document.createElement('div');
			emoji.className = 'ytb-panel-emoji';
			emoji.textContent = note.body;
			const emojiAuthor = document.createElement('div');
			emojiAuthor.className = 'ytb-panel-emoji-author';
			emojiAuthor.textContent = who;
			if (note.clientId !== myClientId) emojiAuthor.style.color = YTB.buddyColor(note.clientId);
			panel.append(emoji, emojiAuthor, buildByline(note, who, false));
		} else if (variant === 'spoiler') {
			const body = document.createElement('p');
			body.className = 'ytb-panel-spoiler';
			body.textContent = 'Spoiler';
			panel.append(body, buildByline(note, who, true));
		} else {
			const body = document.createElement('p');
			body.className = 'ytb-panel-body';
			body.textContent = note.body;
			panel.append(body, buildByline(note, who, true));
		}

		// Note actions: Go here (omitted when already near the moment — nowhere to
		// go), plus the author-only deemphasized delete on a text Note only. The
		// row is appended only when it holds a control.
		const actions = document.createElement('div');
		actions.className = 'ytb-panel-actions';
		if (!YTB.nearNoteMoment(note.timestamp, playhead)) actions.append(buildGoHere(note));
		let confirm = null;
		if (variant === 'text' && note.clientId === myClientId) {
			confirm = buildDeleteConfirm(panel, note, actions); // appends the "Delete" trigger into actions
		}
		if (actions.childElementCount > 0) panel.append(actions);

		// Read-only variants stop here: no conversation, composer, delete, or poll.
		if (variant !== 'text') {
			wirePanelContainment(panel);
			return panel;
		}

		const replies = document.createElement('div');
		replies.className = 'ytb-panel-replies';
		replies.setAttribute('aria-label', 'Replies');

		const replyArea = document.createElement('div');
		replyArea.className = 'ytb-panel-reply-area';

		const error = document.createElement('div');
		error.className = 'ytb-panel-error';
		error.setAttribute('role', 'status');

		panel.append(replies, replyArea, error);
		if (confirm) panel.append(confirm);

		wirePanelContainment(panel);

		// Seed instantly from the last Room read, then poll for freshness.
		renderReplies(panel, repliesFor(note.id));
		updateReplyArea(panel, note, config.sharing, replyCount(note.id));
		refreshConversation(panel);
		return panel;
	}

	/**
	 * The Note's byline: the posted-time (always), with the author before it
	 * unless `showAuthor` is false — a Reaction already names its author beneath
	 * the emoji, so its byline carries the posted time alone.
	 */
	function buildByline(note, who, showAuthor) {
		const byline = document.createElement('div');
		byline.className = 'ytb-panel-byline';
		if (showAuthor) {
			const author = document.createElement('span');
			author.className = 'ytb-panel-author';
			author.textContent = who;
			if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
			byline.append(author);
		}
		const posted = document.createElement('span');
		posted.className = 'ytb-rel ytb-panel-posted';
		posted.dataset.ytbCreatedAt = String(note.createdAt || Date.now());
		posted.dataset.ytbPrefix = 'Posted ';
		posted.textContent = 'Posted ' + YTB.relativeTime(Number(posted.dataset.ytbCreatedAt));
		byline.append(posted);
		return byline;
	}

	/**
	 * Go here: the panel's one seek control. Labelled just "Go here" (no visible
	 * "@time" suffix — the aria-label still speaks the moment); clicking seeks to
	 * ~1s before the Note and resumes playback.
	 */
	function buildGoHere(note) {
		const atLabel = YTB.formatTime(note.timestamp);
		const goHereButton = document.createElement('button');
		goHereButton.type = 'button';
		goHereButton.className = 'ytb-panel-gohere';
		goHereButton.setAttribute('aria-label', `Go here: play from just before ${atLabel}`);
		const goHereText = document.createElement('span');
		goHereText.textContent = 'Go here';
		goHereButton.append(YTBTheme.icon('play'), goHereText);
		goHereButton.addEventListener('click', () => goHere(note));
		return goHereButton;
	}

	/** Keep panel interactions inside the panel (no player seeks/toggles), and
	 * let Escape dismiss it without reaching YouTube's hotkeys. */
	function wirePanelContainment(panel) {
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'click', 'dblclick']) {
			panel.addEventListener(type, (e) => e.stopPropagation());
		}
		panel.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				dismissPanel({ refocusDot: true });
			}
		});
	}

	/**
	 * The author-only delete flow: a deemphasized "Delete" in the Note actions
	 * row that swaps to an in-panel confirmation ("Really delete it?", naming
	 * how many Replies cascade with it). Returns the confirm block; the trigger
	 * is appended to `actions` directly.
	 */
	function buildDeleteConfirm(panel, note, actions) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'ytb-panel-delete';
		remove.textContent = 'Delete';
		actions.append(remove);

		const confirm = document.createElement('div');
		confirm.className = 'ytb-panel-confirm';
		confirm.hidden = true;

		const text = document.createElement('p');
		text.className = 'ytb-panel-confirm-text';

		const confirmActions = document.createElement('div');
		confirmActions.className = 'ytb-panel-confirm-actions';
		const yes = document.createElement('button');
		yes.type = 'button';
		yes.className = 'ytb-panel-confirm-delete';
		yes.textContent = 'Delete';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'ytb-panel-confirm-cancel';
		cancel.textContent = 'Cancel';
		confirmActions.append(yes, cancel);
		confirm.append(text, confirmActions);

		remove.addEventListener('click', () => {
			text.textContent = YTB.deleteConfirmCopy(replyCount(note.id));
			confirm.hidden = false;
			remove.hidden = true;
			positionPanel(panel); // the confirm grows the panel: re-clamp
			yes.focus();
		});
		cancel.addEventListener('click', () => {
			confirm.hidden = true;
			remove.hidden = false;
			positionPanel(panel);
			remove.focus();
		});
		yes.addEventListener('click', async () => {
			if (pendingDelete) return;
			pendingDelete = true;
			yes.disabled = true;
			cancel.disabled = true;
			const ok = await YTB.deleteNote(activeRoomCode, myClientId, note.id);
			pendingDelete = false;
			if (!ok) {
				yes.disabled = false;
				cancel.disabled = false;
				panel.querySelector('.ytb-panel-error').textContent = "We couldn't delete your note. Try again.";
				return;
			}
			removeNoteEverywhere(note);
			dismissPanel({ refocusDot: false });
		});

		return confirm;
	}

	function removeNoteEverywhere(note) {
		const list = notesByVideoId.get(note.videoId) || [];
		notesByVideoId.set(
			note.videoId,
			list.filter((item) => item.id !== note.id),
		);
		repliesByNoteId.delete(note.id);
		renderDots();
	}

	/**
	 * Rebuild the Reply list (oldest → newest), keeping a bottom-pinned scroll.
	 * Reply text is the hero with the author small beneath it (matching the
	 * Note itself); rows that were not in the previous render settle in with a
	 * mild spring — except on the very first render, which seeds silently.
	 */
	function renderReplies(panel, replies) {
		const wrap = panel.querySelector('.ytb-panel-replies');
		if (!wrap) return;
		const pinned = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 24;
		const seen = wrap._ytbSeenReplies || (wrap._ytbSeenReplies = new Set());
		const initial = seen.size === 0;
		wrap.replaceChildren();
		for (const reply of replies) {
			const row = document.createElement('div');
			row.className = 'ytb-panel-reply';
			if (!initial && !seen.has(reply.id)) row.classList.add('ytb-new');
			seen.add(reply.id);
			const body = document.createElement('p');
			body.className = 'ytb-panel-reply-body';
			body.textContent = reply.body;
			const byline = document.createElement('div');
			byline.className = 'ytb-panel-reply-byline';
			const author = document.createElement('span');
			author.className = 'ytb-panel-reply-author';
			author.textContent = reply.clientId === myClientId ? 'You' : YTB.buddyName(reply.clientId, reply.name, roster);
			if (reply.clientId !== myClientId) author.style.color = YTB.buddyColor(reply.clientId);
			const when = document.createElement('span');
			when.className = 'ytb-rel ytb-panel-reply-time';
			when.dataset.ytbCreatedAt = String(reply.createdAt || Date.now());
			when.dataset.ytbPrefix = '';
			when.textContent = YTB.relativeTime(Number(when.dataset.ytbCreatedAt));
			byline.append(author, when);
			row.append(body, byline);
			wrap.append(row);
		}
		if (pinned) wrap.scrollTop = wrap.scrollHeight;
		const panelHost = wrap.closest('#' + PANEL_ID);
		if (panelHost) positionPanel(panelHost);
	}

	/** The bottom of the panel: Reply composer, or the sharing/cap states. */
	function updateReplyArea(panel, note, sharing, count) {
		const area = panel.querySelector('.ytb-panel-reply-area');
		if (!area) return;
		const state = !sharing ? 'sharing-off' : count >= YTB.MAX_REPLIES ? 'capped' : 'composer';
		if (area.dataset.ytbState === state) return;
		area.dataset.ytbState = state;
		area.replaceChildren();

		if (state === 'sharing-off' || state === 'capped') {
			const message = document.createElement('p');
			message.className = 'ytb-panel-reply-note';
			message.textContent = state === 'capped' ? 'Reply limit reached' : 'Turn on Sharing to reply';
			area.append(message);
			return;
		}

		const composer = document.createElement('div');
		composer.className = 'ytb-panel-composer';
		const textarea = document.createElement('textarea');
		textarea.className = 'ytb-panel-reply-input';
		textarea.maxLength = YTB.NOTE_MAX_CHARS;
		textarea.rows = 1;
		textarea.placeholder = 'Reply...';
		textarea.setAttribute('aria-label', 'Write a reply');
		// The @-mention popover must attach BEFORE our own ytb:keydown listener
		// so an open popover consumes Enter/Escape instead of posting/dismissing.
		// (theme.js's capture guard swallows real keydowns on this textarea and
		// re-dispatches them as ytb:keydown, so YouTube's hotkeys see nothing.)
		const mentionCtl = window.YTBMentions ? YTBMentions.attach(textarea) : null;

		// Paper-plane send: springs in once the field is non-empty. Enter still
		// posts and Shift+Enter still inserts a newline.
		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'ytb-panel-send';
		send.setAttribute('aria-label', 'Send reply');
		send.append(YTBTheme.icon('send'));
		const syncSend = () => {
			const filled = textarea.value.trim() !== '';
			send.classList.toggle('show', filled);
			send.tabIndex = filled ? 0 : -1;
			send.setAttribute('aria-hidden', String(!filled));
		};
		send.addEventListener('click', () => submitReply(panel, note, textarea, mentionCtl));

		textarea.addEventListener('input', () => {
			autosize(textarea);
			syncSend();
		});
		textarea.addEventListener('ytb:keydown', (event) => {
			const key = event.detail.original;
			if (key.key === 'Escape') {
				dismissPanel({ refocusDot: true });
				return;
			}
			// Enter posts; Shift+Enter inserts a newline.
			if (key.key === 'Enter' && !key.shiftKey) {
				key.preventDefault();
				submitReply(panel, note, textarea, mentionCtl);
			}
		});
		composer.append(textarea, send);
		area.append(composer);
		syncSend();
	}

	async function submitReply(panel, note, textarea, mentionCtl) {
		const body = textarea.value.trim();
		if (!body || pendingReply) return; // no duplicate submission while pending
		pendingReply = true;
		textarea.disabled = true;
		const error = panel.querySelector('.ytb-panel-error');
		error.textContent = '';

		const clientId = await YTB.ensureClientId();
		const { name } = await YTB.getConfig();
		if (!YTB.isContextActive()) return;
		const result = await YTB.postReply({
			clientId,
			name,
			noteId: note.id,
			body,
			mentions: mentionCtl ? mentionCtl.mentions() : [],
		});
		pendingReply = false;
		textarea.disabled = false;

		if (result.ok) {
			// Success appends immediately, oldest → newest, without closing. The
			// synthetic input resizes the field and retracts the send button.
			textarea.value = '';
			mentionCtl?.reset();
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
			appendLocalReply(panel, note, result.reply);
			textarea.focus();
			return;
		}
		error.textContent = YTB.errorCopy(result.category, 'reply');
		if (result.category === 'reply_cap') {
			updateReplyArea(panel, note, true, YTB.MAX_REPLIES);
			refreshConversation(panel); // pull the replies we didn't know about
		} else if (result.category === 'missing_parent') {
			removeNoteEverywhere(note);
		} else {
			textarea.focus(); // draft intact — retry is one keypress away
		}
	}

	function appendLocalReply(panel, note, reply) {
		// Reconciled by server id: the next Room read / conversation poll can't
		// duplicate this record.
		const list = repliesFor(note.id);
		if (!list.some((existing) => existing.id === reply.id)) {
			repliesByNoteId.set(note.id, [...list, reply]);
		}
		renderReplies(panel, repliesFor(note.id));
		const wrap = panel.querySelector('.ytb-panel-replies');
		if (wrap) wrap.scrollTop = wrap.scrollHeight;
		if (replyCount(note.id) >= YTB.MAX_REPLIES) {
			updateReplyArea(panel, note, true, YTB.MAX_REPLIES);
		}
		renderDots(); // Reply count on the Note Preview updates immediately
	}

	// The focused 5s poll: only while a conversation is open, stopped on close
	// and on navigation. Discovers Buddy Replies (and deletion) promptly.
	function startConversationPoll(panel) {
		if (!YTB.isContextActive()) return;
		stopConversationPoll();
		pollTimer = setInterval(() => refreshConversation(panel), CONVERSATION_POLL_MS);
	}

	function stopConversationPoll() {
		if (pollTimer) clearInterval(pollTimer);
		if (labelTimer) clearInterval(labelTimer);
		pollTimer = null;
		labelTimer = null;
	}

	async function refreshConversation(panel) {
		const note = openNote;
		if (!note || !activeRoomCode || !panel.isConnected) return;
		const result = await YTB.getConversation(activeRoomCode, note.id);
		if (openNote !== note || !panel.isConnected) return; // closed/replaced meanwhile

		if (result.ok) {
			repliesByNoteId.set(note.id, result.replies);
			// Replies surfacing while their conversation is OPEN are on screen —
			// Acknowledge them now so closing the panel never starts a pulse for
			// something the viewer just read.
			recomputeUnseen();
			acknowledgeDot(note.id);
			renderReplies(panel, result.replies);
			const { sharing } = await YTB.getConfig();
			if (!YTB.isContextActive()) return;
			if (openNote === note) updateReplyArea(panel, note, sharing, result.replies.length);
			renderDots();
			return;
		}
		if (result.category === 'missing_parent') {
			// Deleted while open: freeze the panel into the safe message.
			stopConversationPoll();
			removeNoteEverywhere(note);
			const error = panel.querySelector('.ytb-panel-error');
			if (error) error.textContent = 'This note is no longer available.';
			const area = panel.querySelector('.ytb-panel-reply-area');
			if (area) area.replaceChildren();
		}
		// Transient failures: keep the panel as-is; the next tick retries.
	}

	function refreshTimeLabels(panel) {
		for (const label of panel.querySelectorAll('.ytb-rel')) {
			label.textContent = (label.dataset.ytbPrefix || '') + YTB.relativeTime(Number(label.dataset.ytbCreatedAt));
		}
	}

	/** Anchor above the Note's dot, clamped fully inside the player. */
	function positionPanel(panel) {
		const host = player();
		if (!host || !panel.isConnected) return;
		const hostRect = host.getBoundingClientRect();
		const width = Math.min(300, Math.max(220, hostRect.width - 24));
		panel.style.width = width + 'px';

		const bar = document.querySelector('.ytp-progress-bar');
		const barRect = bar ? bar.getBoundingClientRect() : null;
		const bottom = barRect ? Math.max(12, hostRect.bottom - barRect.top + 12) : 72;
		panel.style.bottom = Math.min(bottom, Math.max(12, hostRect.height - 40)) + 'px';

		const dot = openNote && dotFor(openNote.id);
		const dotRect = dot ? dot.getBoundingClientRect() : null;
		const center = dotRect ? dotRect.left + dotRect.width / 2 - hostRect.left : hostRect.width / 2;
		const left = Math.max(8, Math.min(center - width / 2, hostRect.width - width - 8));
		panel.style.left = left + 'px';

		// Never taller than the player: the Reply list absorbs the squeeze. The
		// fixed chrome around it (body, byline, actions, composer, error, and a
		// visible delete confirmation) is measured live, so content changes that
		// grow the panel re-clamp instead of pushing it past the player's top.
		// If even the minimum list cannot fit above the bar, the panel slides
		// down over the control bar rather than out of the player.
		const replies = panel.querySelector('.ytb-panel-replies');
		if (replies) {
			const chrome = panel.offsetHeight - replies.offsetHeight;
			let anchor = parseFloat(panel.style.bottom);

			// Margin the panel keeps from its own ceiling. Normally 16px below the
			// player's top; but while YouTube's storyboard thumbnail floats above
			// the scrubber, cap the panel just below it instead so it sits below
			// the thumbnail, the Reply list absorbing the squeeze exactly as it
			// does against the player top. Skipped when the thumbnail hugs the
			// scrubber and would leave no usable panel — the panel's own high
			// z-index keeps it above the thumbnail there, so nothing is clipped.
			let topMargin = 16;
			const tip = document.querySelector('.ytp-tooltip');
			if (tip && tip.offsetParent !== null) {
				const tipRect = tip.getBoundingClientRect();
				const belowThumb = hostRect.bottom - tipRect.bottom; // gap bottom->thumb bottom
				const reserve = hostRect.height - belowThumb; // margin from the top to clear it
				if (tipRect.height > 0 && reserve > 16 && anchor + chrome + 120 + reserve <= hostRect.height) {
					topMargin = reserve;
				}
			}

			if (anchor + chrome + 64 + topMargin > hostRect.height) {
				anchor = Math.max(12, hostRect.height - chrome - 64 - topMargin);
				panel.style.bottom = anchor + 'px';
			}
			const spare = hostRect.height - anchor - topMargin;
			replies.style.maxHeight = Math.max(64, Math.min(180, spare - chrome)) + 'px';
		}
	}

	function removePanel() {
		stopConversationPoll();
		document.getElementById(PANEL_ID)?.remove();
		document.querySelector('.' + DOT_OPEN_CLASS)?.classList.remove(DOT_OPEN_CLASS);
		openNote = null;
		pendingReply = false;
		pendingDelete = false;
	}

	/**
	 * Dismiss the Expanded Note (outside click, Escape, delete, navigation). If
	 * opening it paused a playing video, dismissal resumes; a video that was
	 * already paused stays paused. Keyboard dismissal refocuses the origin dot.
	 */
	function dismissPanel({ refocusDot = false, resume = true } = {}) {
		const noteId = openNote && openNote.id;
		const wasOpen = Boolean(document.getElementById(PANEL_ID));
		removePanel();
		if (!wasOpen) return;
		const video = document.querySelector('video');
		if (resume && pauseLease && video && video.paused) video.play();
		pauseLease = false;
		if (refocusDot && noteId) {
			const dot = dotFor(noteId);
			if (dot) dot.focus();
		}
	}

	// Outside click dismisses. The opening click never lands here because dot,
	// preview, panel, and notification-card handlers all stop propagation.
	document.addEventListener('click', (event) => {
		if (!document.getElementById(PANEL_ID)) return;
		const path = event.composedPath ? event.composedPath() : [];
		for (const target of path) {
			if (!(target instanceof Element)) continue;
			if (target.id === PANEL_ID || target.classList.contains(DOT_CLASS) || target.classList.contains('ytb-alert-card')) return;
		}
		dismissPanel();
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && document.getElementById(PANEL_ID)) {
			dismissPanel({ refocusDot: true });
		}
	});

	// Manually resuming playback closes the panel (without re-pausing) — EXCEPT a
	// play during the load-churn grace after a Room Feed row opened the panel,
	// where autoplay kicking in as the watch page settles must not dismiss it.
	document.addEventListener(
		'play',
		(event) => {
			if (!(event.target instanceof HTMLVideoElement)) return;
			const action = YTB.panelPlayAction({
				panelOpen: Boolean(document.getElementById(PANEL_ID)),
				withinGrace: Date.now() < pendingOpenGuardUntil,
			});
			if (action === 'ignore') return;
			if (action === 'hold') {
				// Re-assert the pause so the viewer can read the Note. Take the lease
				// if OPENING didn't (the video wasn't playing yet), so an outside-click
				// dismissal still resumes the playback the viewer was sent to.
				pauseLease = true;
				event.target.pause();
				return;
			}
			pauseLease = false;
			dismissPanel({ resume: false });
		},
		true,
	);

	YTB.onContextInvalidated(() => {
		stopConversationPoll();
		dismissPanel({ resume: false });
	});

	// ---------------------------------------------------------------------------
	// Playback Notifications.
	// ---------------------------------------------------------------------------

	function alertsContainer() {
		const host = player();
		if (!host) return null;
		let wrap = document.getElementById(ALERTS_ID);
		if (!wrap || wrap.parentElement !== host) {
			wrap?.remove();
			wrap = document.createElement('div');
			wrap.id = ALERTS_ID;
			host.appendChild(wrap);
		}
		applyAlertsPosition(wrap, host);
		return wrap;
	}

	/**
	 * Anchor the alerts stack at the viewer's Notification Position AND lay its
	 * children ALONG that edge: one of the four player edges (default bottom).
	 * Top/bottom become a centered horizontal row that wraps to another line
	 * (away from the edge) when it outgrows the player; left/right stay a vertical
	 * column. Inline styles own placement and axis so a Settings change re-anchors
	 * and re-flows an existing stack live; the stylesheet carries only the static
	 * look (gap, z-index).
	 */
	function applyAlertsPosition(wrap, host) {
		const edge = YTB.NOTIFICATION_EDGES.includes(notificationPosition) ? notificationPosition : 'bottom';
		const horizontal = edge === 'top' || edge === 'bottom';
		wrap.style.top = '';
		wrap.style.bottom = '';
		wrap.style.left = '';
		wrap.style.right = '';
		wrap.style.transform = '';
		// Main axis runs along the edge; a row wraps (bottom wraps upward so new
		// lines stay off the edge), a column never wraps (height cap deferred).
		wrap.style.flexDirection = horizontal ? 'row' : 'column';
		wrap.style.flexWrap = edge === 'bottom' ? 'wrap-reverse' : edge === 'top' ? 'wrap' : 'nowrap';
		wrap.style.justifyContent = horizontal ? 'center' : 'flex-start';
		// Cap a row to the player so it wraps instead of clipping; a column is free.
		wrap.style.maxWidth = horizontal ? 'calc(100% - 32px)' : '';
		wrap.style.alignItems = edge === 'left' ? 'flex-start' : edge === 'right' ? 'flex-end' : 'center';
		if (horizontal) {
			wrap.style.left = '50%';
			wrap.style.transform = 'translateX(-50%)';
			if (edge === 'top') wrap.style.top = alertsTopPx(host) + 'px';
			else wrap.style.bottom = alertsBottomPx(host) + 'px';
		} else {
			wrap.style.top = '50%';
			wrap.style.transform = 'translateY(-50%)';
			if (edge === 'left') wrap.style.left = '16px';
			else wrap.style.right = '16px';
		}
	}

	// Sit above the control bar and above any visible caption windows, inside
	// the player, in both watch mode and fullscreen.
	function alertsBottomPx(host) {
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

	// The top-zone mirror of alertsBottomPx: clear the player's top chrome
	// (title/gradient) when visible, staying inside the player.
	function alertsTopPx(host) {
		const hostRect = host.getBoundingClientRect();
		let top = 16;
		const chromeTop = host.querySelector('.ytp-chrome-top');
		if (chromeTop && !host.classList.contains('ytp-autohide')) {
			const rect = chromeTop.getBoundingClientRect();
			if (rect.height > 0) top = Math.max(top, rect.bottom - hostRect.top + 10);
		}
		return Math.min(top, Math.max(16, hostRect.height / 2));
	}

	function showNoteCard(note) {
		const wrap = alertsContainer();
		if (!wrap) return;
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster);
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
		if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
		// Author beneath the content, matching the Note Preview (no timestamp here —
		// a Playback Notification fires exactly as playback crosses the moment).
		card.append(body, author);
		card.addEventListener('click', (event) => {
			event.stopPropagation();
			card.remove();
			openPanel(note); // pauses in place; never seeks
		});
		wrap.append(card);
		requestAnimationFrame(() => card.classList.add('show'));
		setTimeout(() => {
			card.classList.remove('show');
			setTimeout(() => card.remove(), 250);
		}, NOTE_CARD_MS);
	}

	function showReactionBurst(note) {
		const wrap = alertsContainer();
		if (!wrap) return;
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster);
		const burst = document.createElement('div');
		burst.className = 'ytb-alert-burst';
		// Spacing is the flex row's job now; the burst only floats and fades.
		const emoji = document.createElement('div');
		emoji.className = 'ytb-alert-burst-emoji';
		emoji.textContent = note.body;
		const author = document.createElement('div');
		author.className = 'ytb-alert-burst-author';
		author.textContent = who;
		// Over the raw video (no card): Buddy Color with a shadow keeps identity
		// legible; own bursts stay the default white "You".
		if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
		burst.append(emoji, author);
		wrap.append(burst);
		setTimeout(() => burst.remove(), REACTION_BURST_MS);
	}

	// Natural forward crossings only: every ordinary playback crossing triggers
	// (including replays after rewinding); seeks rebase silently below.
	function handleCrossings(video) {
		const currentTime = Number(video.currentTime);
		if (!currentVideoId || !Number.isFinite(currentTime)) {
			lastPlaybackTime = null;
			return;
		}
		const previousTime = lastPlaybackTime;
		lastPlaybackTime = currentTime;
		// Notes off suppresses the notification but keeps rebasing the crossing
		// window, so turning Notes back on never replays a backlog.
		if (
			notesHidden ||
			previousTime === null ||
			video.seeking ||
			currentTime <= previousTime ||
			currentTime - previousTime > NATURAL_DELTA_SECONDS
		) {
			return;
		}
		for (const note of YTB.crossedNotes(notesForCurrentVideo(), previousTime, currentTime)) {
			// Queue the entrance (drained one-per-beat, in timestamp order) but
			// Acknowledge NOW: the crossing itself is the ADR-0010 trigger, not the
			// staggered reveal — a no-op unless the dot was Unseen.
			alertQueue.push(note);
			acknowledgeDot(note.id);
		}
		scheduleAlertDrain();
	}

	// Reveal one queued Note per ENTRANCE_STAGGER_MS beat, in the order queued
	// (crossedNotes is timestamp-sorted). Earlier notifications stay on screen as
	// later ones arrive — each lives its own lifetime from its own entrance.
	function scheduleAlertDrain() {
		if (alertDrainTimer !== null || alertQueue.length === 0) return;
		drainNextAlert();
	}

	function drainNextAlert() {
		const note = alertQueue.shift();
		if (!note) {
			alertDrainTimer = null;
			return;
		}
		if (note.kind === 'emoji') showReactionBurst(note);
		else showNoteCard(note);
		alertDrainTimer = setTimeout(drainNextAlert, ENTRANCE_STAGGER_MS);
	}

	// Drop every on-screen and queued notification and cancel the drain — for a
	// Notes-off toggle and a real video change (a duplicate navigate keeps them).
	function resetAlerts() {
		alertQueue = [];
		if (alertDrainTimer !== null) {
			clearTimeout(alertDrainTimer);
			alertDrainTimer = null;
		}
		document.getElementById(ALERTS_ID)?.replaceChildren();
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer of content.js events; registered synchronously.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', (event) => {
		const nextVideoId = (event.detail && event.detail.videoId) || null;
		// A duplicate navigation-finish for the SAME video — YouTube re-emits these
		// as the watch page loads (content.js forwards every yt-navigate-finish).
		// Treat it as a no-op: tearing the panel down here is what dismissed an
		// Expanded Note a Room Feed row had just opened. Keep the panel, lease, and
		// alerts; only reconcile dots.
		if (nextVideoId === currentVideoId) {
			renderDots();
			return;
		}
		currentVideoId = nextVideoId;
		lastPlaybackTime = null;
		pendingOpenGuardUntil = 0;
		dismissPanel({ resume: false });
		pauseLease = false;
		resetAlerts(); // clear on-screen + queued, cancel the drain
		renderDots();
	});

	document.addEventListener('ytb:mutation', () => {
		renderDots();
		const panel = document.getElementById(PANEL_ID);
		if (panel) positionPanel(panel);
	});

	for (const type of ['resize', 'fullscreenchange']) {
		window.addEventListener(type, () => {
			const panel = document.getElementById(PANEL_ID);
			if (panel) positionPanel(panel);
		});
	}

	// Seeking rebases the crossing window (a direct seek across timestamps stays
	// silent); timeupdate drives Spoiler lock state and natural crossings.
	document.addEventListener(
		'seeking',
		(event) => {
			if (event.target instanceof HTMLVideoElement) lastPlaybackTime = Number(event.target.currentTime);
		},
		true,
	);

	document.addEventListener(
		'timeupdate',
		(event) => {
			if (!(event.target instanceof HTMLVideoElement)) return;
			renderDots();
			handleCrossings(event.target);
		},
		true,
	);

	/** Grow a one-line textarea to at most two visual lines. */
	function autosize(textarea) {
		textarea.style.height = 'auto';
		const line = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
		const max = line * 2 + 14;
		textarea.style.height = Math.min(textarea.scrollHeight, max) + 'px';
	}

	/** Inject the notes stylesheet once. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* A flat, single-color circle floating just clear of the bar's top edge
         (a child of the bar, so it inherits the control chrome's autohide fade
         and stays bar-aligned through resizes and fullscreen for free). No
         border, outline, ring, or shadow — a pale dot over a bright frame is
         the accepted trade. */
      .${DOT_CLASS} {
        position: absolute;
        bottom: calc(100% + 3px);
        width: 6px;
        height: 6px;
        margin-left: -3px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: #fff;
        z-index: 41;
        cursor: default;
      }
      .${DOT_TEXT_CLASS} { cursor: pointer; }
      .${DOT_CLASS}:focus-visible {
        outline: 2px solid var(--ytb-accent-500);
        outline-offset: 1px;
      }
      /* Locked Spoilers stay visually obscured. The obscuring is a veil overlay
         rather than filter/opacity on the dot itself: a filter would gray out —
         and element opacity would fade — the apricot Unseen halo and the hover
         preview, both rendered on/inside this same element. (The preview child
         carries its own z-index, so it paints above the veil.) */
      .${DOT_LOCKED_CLASS} { cursor: pointer; }
      .${DOT_LOCKED_CLASS}::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: rgba(58, 58, 58, 0.78);
        transition: background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .${DOT_LOCKED_CLASS}:hover::before, .${DOT_LOCKED_CLASS}:focus-visible::before {
        background: rgba(58, 58, 58, 0.45);
      }

      /* --- Unseen pulse (ADR-0010): an expanding apricot halo, box-shadow
         only — the dot never moves, resizes, or recolors, and neighbouring
         dots (at their true, possibly overlapping fractions) are never
         displaced. Shares the popup Waiting dot's ~1.6s breathing rhythm
         (DESIGN.md section 2). */
      .${DOT_UNSEEN_CLASS} {
        animation: ytb-unseen-pulse 1.6s var(--ytb-ease-out) infinite;
      }
      @keyframes ytb-unseen-pulse {
        from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ytb-accent-500) 75%, transparent); }
        to   { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ytb-accent-500) 0%, transparent); }
      }
      /* While a Note's panel is open, its own hover preview stays hidden — and
         hidden INSTANTLY (no fade), so it vanishes on the first frame of the
         Expanded Note that grows out of it rather than lingering beside it. */
      .${DOT_OPEN_CLASS} .${PREVIEW_CLASS} {
        opacity: 0 !important;
        transform: translateX(-50%) scale(0.6) !important;
        transition: none !important;
        pointer-events: none !important;
      }

      /* --- Note Preview: opaque warm card (apricot system) ---
         The preview unfolds OUT OF the dot on hover: it scales up from the dot's
         own point (transform-origin sits 15px below the card's bottom edge — the
         18px bottom gap less the 3px dot half-height), so it grows from the dot
         rather than fading in from its own centre. Pure CSS off the hover state;
         reduced-motion collapses it to an opacity-only fade below. */
      .${PREVIEW_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        transform-origin: 50% calc(100% + 15px);
        transform: translateX(-50%) scale(0.6);
        width: max-content;
        max-width: 240px;
        padding: 9px 11px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        box-shadow: var(--ytb-e-pop);
        font: 12px/1.4 var(--ytb-font);
        text-align: left;
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--ytb-dur-quick) var(--ytb-ease-out), transform var(--ytb-dur-quick) var(--ytb-ease-spring);
        z-index: 60;
      }
      /* Transparent hover bridge: a dot-width column spanning the gap between the
         preview and the dot so the pointer can travel straight up onto the card
         without dropping :hover. Kept narrow (not full preview width) so sliding
         horizontally along the progress bar off the dot drops the preview. It is
         interactive only while the dot is hovered, so it never blocks the
         scrubber; hovering it (a dot descendant) keeps .${DOT_CLASS}:hover alive. */
      .${PREVIEW_CLASS}::before {
        content: '';
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: 16px;
        top: 100%;
        height: 22px;
        pointer-events: none;
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS}::before {
        pointer-events: auto;
      }
      /* Every preview kind accepts a click anywhere on it (it bubbles to the
         dot's handler, which opens the Expanded Note). The Reaction preview
         stays transparent but is clickable too, so clicking the card opens its
         read-only panel exactly like clicking the tiny dot. */
      .${DOT_TEXT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_TEXT_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:focus-visible .${PREVIEW_CLASS} {
        pointer-events: auto;
        cursor: pointer;
      }
      /* Reactions keep the transparent over-video treatment (not a card),
         always at natural height. */
      .${PREVIEW_CLASS}.ytb-preview-reaction {
        border: 0;
        background: transparent;
        box-shadow: none;
        color: #fff;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding-top: 18px;
        min-width: 52px;
        text-align: center;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
      }
      /* The Note's video timestamp, pinned in the top-right corner of both the
         text card and the transparent Reaction preview. */
      .ytb-preview-time {
        position: absolute;
        top: 7px;
        right: 9px;
        color: var(--ytb-ink-faint);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ytb-preview-reaction .ytb-preview-time { color: #eee; }
      /* Content is the hero; the author sits small beneath it (own authorship
         stays the muted neutral "You"; Buddies get their Buddy Color inline). */
      .ytb-preview-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        padding-right: 34px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .ytb-preview-author { margin-top: 4px; font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-preview-replies { margin-top: 4px; color: var(--ytb-accent-800); font-size: 11px; font-weight: 700; }
      .ytb-preview-spoiler { padding-right: 34px; color: var(--ytb-ink-muted); font-style: italic; font-weight: 600; }
      .ytb-preview-emoji { font-size: 26px; line-height: 1.1; }
      .ytb-preview-emoji-author { margin-top: 2px; color: #eee; font-size: 11px; font-weight: 700; }

      /* --- the Expanded Note: opaque warm surface (cream / espresso) ---
         Its entrance is a JS FLIP (flipPanelOpen) that grows the panel out of the
         Note Preview — or the dot — it replaced, so there is no standalone pop-in
         keyframe here. (ytb-pop-in still animates Replies and the delete confirm.) */
      #${PANEL_ID} {
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
      }
      #${PANEL_ID}:focus { outline: none; }
      @keyframes ytb-pop-in {
        from { opacity: 0; transform: scale(0.96) translateY(4px); }
      }
      /* The Note's video timestamp, pinned top-right (matching the Note Preview's
         corner timestamp); every panel variant reserves room for it. */
      .ytb-panel-time {
        position: absolute;
        top: 12px;
        right: 14px;
        color: var(--ytb-ink-faint);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ytb-panel-body { margin: 0; padding-right: 42px; font-size: 15px; line-height: 1.4; font-weight: 700; overflow-wrap: anywhere; }
      /* Locked Spoiler variant: the masked body, muted and italic like its preview. */
      .ytb-panel-spoiler { margin: 0; padding-right: 42px; font-size: 15px; line-height: 1.4; font-weight: 600; font-style: italic; color: var(--ytb-ink-muted); }
      /* Reaction variant: the large emoji with its author directly beneath, mirroring the Note Preview. */
      .ytb-panel-emoji { font-size: 32px; line-height: 1.15; padding-right: 42px; }
      .ytb-panel-emoji-author { margin-top: 2px; font-size: 12px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-byline {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-top: 4px;
      }
      .ytb-panel-author { font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-posted { color: var(--ytb-ink-faint); font-size: 11px; white-space: nowrap; }
      .ytb-panel-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 10px;
      }
      /* Go here: the one apricot primary in the panel. */
      .ytb-panel-gohere {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border: 0;
        border-radius: var(--ytb-r-pill);
        background: var(--ytb-accent-500);
        color: var(--ytb-on-accent);
        font: 700 12px/1 var(--ytb-font);
        cursor: pointer;
        transition:
          background var(--ytb-dur-quick) var(--ytb-ease-out),
          transform var(--ytb-dur-quick) var(--ytb-ease-spring);
      }
      .ytb-panel-gohere:hover { background: var(--ytb-accent-600); }
      .ytb-panel-gohere:active { transform: scale(0.97); }
      .ytb-panel-gohere:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      .ytb-panel-gohere svg { width: 12px; height: 12px; }
      .ytb-panel-delete {
        padding: 6px 8px;
        border: 0;
        border-radius: var(--ytb-r-sm);
        background: transparent;
        color: var(--ytb-ink-faint);
        font: 600 12px/1 var(--ytb-font);
        cursor: pointer;
        transition: color var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-delete:hover, .ytb-panel-delete:focus-visible { color: var(--ytb-danger-text); outline: none; }
      .ytb-panel-delete:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      .ytb-panel-replies {
        max-height: 180px;
        overflow-y: auto;
        margin-top: 10px;
        border-top: 1px solid var(--ytb-line);
      }
      .ytb-panel-replies:empty { margin-top: 0; border-top: 0; }
      .ytb-panel-reply { padding: 8px 0 2px; }
      .ytb-panel-reply.ytb-new { animation: ytb-pop-in var(--ytb-dur-slow) var(--ytb-ease-spring); }
      .ytb-panel-reply-body { margin: 0; overflow-wrap: anywhere; }
      .ytb-panel-reply-byline { display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; }
      .ytb-panel-reply-author { font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-reply-time { color: var(--ytb-ink-faint); font-size: 11px; white-space: nowrap; }
      .ytb-panel-reply-area { margin-top: 10px; }
      .ytb-panel-composer { position: relative; display: flex; align-items: flex-end; gap: 6px; }
      .ytb-panel-reply-input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: var(--ytb-r-sm);
        background: var(--ytb-surface-sunk);
        color: var(--ytb-ink);
        font: 13px/1.4 var(--ytb-font);
        resize: none;
        overflow: hidden;
        transition:
          border-color var(--ytb-dur-quick) var(--ytb-ease-out),
          box-shadow var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-reply-input::placeholder { color: var(--ytb-ink-faint); }
      .ytb-panel-reply-input:focus { border-color: var(--ytb-accent-500); box-shadow: 0 0 0 3px var(--ytb-ring); outline: none; }
      /* Paper-plane send: springs in once the field is non-empty. */
      .ytb-panel-send {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: var(--ytb-accent-500);
        color: var(--ytb-on-accent);
        cursor: pointer;
        opacity: 0;
        transform: scale(0.5);
        pointer-events: none;
        transition:
          opacity var(--ytb-dur-quick) var(--ytb-ease-out),
          transform var(--ytb-dur-base) var(--ytb-ease-spring),
          background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-send.show { opacity: 1; transform: scale(1); pointer-events: auto; }
      .ytb-panel-send:hover { background: var(--ytb-accent-600); }
      .ytb-panel-send:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }
      .ytb-panel-send svg { width: 15px; height: 15px; }
      .ytb-panel-reply-note { margin: 4px 0 0; color: var(--ytb-ink-muted); font-size: 12px; }
      .ytb-panel-error { min-height: 16px; margin-top: 6px; color: var(--ytb-danger-text); font-size: 12px; font-weight: 600; }
      /* Delete confirmation: cream sub-panel with the danger-button treatment. */
      .ytb-panel-confirm {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface-tint);
        animation: ytb-pop-in var(--ytb-dur-base) var(--ytb-ease-spring);
      }
      .ytb-panel-confirm-text { margin: 0 0 8px; font-weight: 600; }
      .ytb-panel-confirm-actions { display: flex; gap: 8px; }
      .ytb-panel-confirm-delete {
        padding: 6px 14px;
        border: 0;
        border-radius: var(--ytb-r-pill);
        background: var(--ytb-danger);
        color: var(--ytb-on-fill);
        font: 700 12px/1.3 var(--ytb-font);
        cursor: pointer;
        transition: background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-confirm-delete:hover { background: var(--ytb-danger-hover); }
      .ytb-panel-confirm-cancel {
        padding: 6px 14px;
        border: 1px solid var(--ytb-line-strong);
        border-radius: var(--ytb-r-pill);
        background: var(--ytb-surface-tint);
        color: var(--ytb-ink);
        font: 600 12px/1.3 var(--ytb-font);
        cursor: pointer;
        transition: background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-confirm-cancel:hover { background: var(--ytb-accent-050); }
      .ytb-panel-confirm-delete:disabled, .ytb-panel-confirm-cancel:disabled { opacity: 0.5; cursor: default; }
      .ytb-panel-confirm-delete:focus-visible, .ytb-panel-confirm-cancel:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }

      /* --- Playback Notifications ---
         Placement AND main axis (row for top/bottom, column for left/right, plus
         wrap and centering) are inline via applyAlertsPosition; only the static
         look lives here. */
      #${ALERTS_ID} {
        position: absolute;
        z-index: 2050;
        display: flex;
        gap: 8px;
        pointer-events: none;
      }
      .ytb-alert-card {
        pointer-events: auto;
        width: max-content;
        max-width: 200px;
        box-sizing: border-box;
        padding: 9px 12px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        font: 12px/1.4 var(--ytb-font);
        text-align: left;
        box-shadow: var(--ytb-e-pop);
        cursor: pointer;
        opacity: 0;
        transform: translateY(10px) scale(0.97);
        transition:
          opacity var(--ytb-dur-base) var(--ytb-ease-out),
          transform var(--ytb-dur-slow) var(--ytb-ease-spring);
      }
      .ytb-alert-card.show { opacity: 1; transform: translateY(0) scale(1); }
      .ytb-alert-card:focus-visible { outline: none; box-shadow: var(--ytb-e-pop), 0 0 0 3px var(--ytb-ring); }
      .ytb-alert-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .ytb-alert-author { margin-top: 3px; font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-alert-burst {
        pointer-events: none;
        text-align: center;
        animation: ytb-burst ${REACTION_BURST_MS}ms ease-out forwards;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
      }
      .ytb-alert-burst-emoji { font-size: 34px; line-height: 1.1; }
      .ytb-alert-burst-author { color: #fff; font: 700 11px var(--ytb-font); }
      @keyframes ytb-burst {
        0%   { opacity: 0; translate: 0 10px; }
        15%  { opacity: 1; translate: 0 0; }
        70%  { opacity: 1; translate: 0 -18px; }
        100% { opacity: 0; translate: 0 -30px; }
      }
      @keyframes ytb-burst-fade {
        0%   { opacity: 0; }
        15%  { opacity: 1; }
        70%  { opacity: 1; }
        100% { opacity: 0; }
      }
      /* Springs -> ease-out and transforms -> none; short opacity fades stay. */
      @media (prefers-reduced-motion: reduce) {
        .ytb-panel-confirm, .ytb-panel-reply.ytb-new { animation: none; }
        /* The Note Preview's unfold-from-the-dot collapses to a plain opacity
           fade: the centring translate stays constant (so nothing animates), but
           the scale and its transition are dropped. The Expanded Note's FLIP is
           skipped in JS on this same query, fading opacity only. */
        .${PREVIEW_CLASS},
        .${DOT_CLASS}:hover .${PREVIEW_CLASS},
        .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
          transform: translateX(-50%);
          transition: opacity var(--ytb-dur-quick) linear;
        }
        /* Unseen: a static 2px accent ring replaces the looping halo. */
        .${DOT_UNSEEN_CLASS} {
          animation: none;
          box-shadow: 0 0 0 2px var(--ytb-accent-500);
        }
        .ytb-panel-send, .ytb-alert-card {
          transform: none;
          transition: opacity var(--ytb-dur-base) linear;
        }
        .ytb-panel-send.show, .ytb-alert-card.show { transform: none; }
        .ytb-alert-burst { animation-name: ytb-burst-fade; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
