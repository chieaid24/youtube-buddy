// extension/notes.js
//
// ALL Note & Reaction presentation on the watch page:
//   - Video Timeline dots (text Notes, Reactions, locked Spoilers), spread
//     apart when timestamps fall within 2 seconds so each keeps its own
//     pointer/keyboard target;
//   - hover/focus Note Previews (two-line body, author beneath, Reply count,
//     corner timestamp) reachable across a transparent hover bridge;
//   - the Expanded Note: a pinned conversation panel with Replies, a Reply
//     composer (paper-plane send), a "Go here" seek-and-play control, and the
//     author-only delete confirmation;
//   - click-to-seek on locked Spoiler dots (Go here without opening — the Note
//     reveals through its natural crossing, never early);
//   - Playback Notifications: bottom-center note cards (~4s, clickable) and
//     animated Reaction bursts (~2s, non-interactive) on every NATURAL forward
//     crossing — rewind-and-replay triggers again, direct seeks stay silent.
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
	const PREVIEW_CLASS = 'ytb-note-preview';
	const PANEL_ID = 'ytb-note-panel';
	const ALERTS_ID = 'ytb-note-alerts';
	const STYLE_ID = 'ytb-notes-style';
	// Toggled on #movie_player while a Note dot/preview is hovered so YouTube's
	// native scrubber tooltip hides ONLY its time readout (thumbnail stays).
	const SCRUB_HIDE_CLASS = 'ytb-hide-scrub-time';

	const CONVERSATION_POLL_MS = 5000; // focused Expanded Note freshness
	const LABEL_REFRESH_MS = 30_000; // "Posted 8 min ago" recomputation
	const NOTE_CARD_MS = 4000; // text-note Playback Notification lifetime
	const REACTION_BURST_MS = 2000; // Reaction float-and-fade lifetime
	// Steps larger than this between timeupdates are seeks, not playback.
	const NATURAL_DELTA_SECONDS = YTB.SPREAD_WINDOW_SECONDS;

	// --- state ---
	let myClientId = null;
	let activeRoomCode = '';
	let notesByVideoId = new Map(); // videoId -> Note[] (mine and Buddies')
	let repliesByNoteId = new Map(); // noteId -> Reply[] oldest-first (Room reads + local appends)
	let currentVideoId = null;
	let lastPlaybackTime = null; // previous timeupdate, for natural crossings
	let burstCount = 0; // fans concurrent Reaction bursts apart

	// Expanded Note state. `pauseLease` records whether OPENING (the first panel
	// in a chain of replacements) paused a playing video: an outside dismissal
	// then resumes; a video that was already paused stays paused.
	let openNote = null;
	let pauseLease = false;
	let pollTimer = null;
	let labelTimer = null;
	let pendingReply = false;
	let pendingDelete = false;

	injectStyle();

	// ---------------------------------------------------------------------------
	// Data intake: Room broadcasts, immediate post reconciliation.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:room-data', (event) => {
		const detail = (event && event.detail) || {};
		myClientId = detail.myClientId || myClientId;
		activeRoomCode = detail.roomCode || '';

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
		renderDots();
	});

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
		const desired = new Map(); // id -> { note, locked }
		const naturals = []; // for spreadFractions
		if (Number.isFinite(duration) && duration > 0) {
			for (const note of notesForCurrentVideo()) {
				const timestamp = Number(note.timestamp);
				if (!Number.isFinite(timestamp)) continue;
				desired.set(note.id, {
					note,
					// Spoiler state follows the viewer's playhead and can relock when
					// the video is revisited from an earlier point.
					locked: Boolean(note.spoiler) && playhead < timestamp,
				});
				naturals.push({
					id: note.id,
					timestamp,
					fraction: Math.max(0, Math.min(1, timestamp / duration)),
				});
			}
		}

		// Dots within 2s would overlap: spread them apart (display position only —
		// labels and the Expanded Note keep the true timestamp).
		const barWidth = bar.getBoundingClientRect().width;
		const minGap = barWidth > 0 ? Math.max(0.008, 11 / barWidth) : 0.012;
		const fractions = YTB.spreadFractions(naturals, minGap);

		const existing = new Map();
		for (const dot of bar.querySelectorAll(':scope > .' + DOT_CLASS)) {
			const id = dot.dataset.ytbNoteId;
			if (desired.has(id)) existing.set(id, dot);
			else dot.remove();
		}
		if (desired.size === 0) return;
		if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';

		for (const [id, { note, locked }] of desired) {
			let dot = existing.get(id);
			if (!dot) {
				dot = document.createElement('button');
				dot.type = 'button';
				dot.className = DOT_CLASS;
				dot.dataset.ytbNoteId = id;
				const preview = dot.appendChild(document.createElement('div'));
				preview.className = PREVIEW_CLASS;
				// Never let the player interpret a dot press as a seek. Clicking the
				// dot OR its Note Preview opens the conversation (activation re-checks
				// kind and Spoiler lock).
				for (const type of ['mousedown', 'touchstart', 'pointerdown']) {
					dot.addEventListener(type, (e) => e.stopPropagation());
				}
				dot.addEventListener('click', (e) => {
					e.stopPropagation();
					e.preventDefault();
					onDotActivate(dot);
				});
				// While the dot (and its preview, a descendant) is hovered, suppress
				// YouTube's native scrubber time so our corner timestamp stands alone.
				dot.addEventListener('mouseenter', () => player()?.classList.add(SCRUB_HIDE_CLASS));
				dot.addEventListener('mouseleave', () => player()?.classList.remove(SCRUB_HIDE_CLASS));
				bar.appendChild(dot);
			}
			dot.style.left = ((fractions.get(id) || 0) * 100).toFixed(3) + '%';
			dot.style.background = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);
			// The open Note's own hover preview is redundant next to its panel.
			dot.classList.toggle(DOT_OPEN_CLASS, Boolean(openNote) && openNote.id === id);

			const count = replyCount(id);
			const signature = JSON.stringify([locked, note.kind, note.clientId, note.name, note.body, count]);
			if (dot.dataset.ytbSig === signature) continue;
			dot.dataset.ytbSig = signature;

			const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name);
			const at = YTB.formatTime(note.timestamp);
			const isReaction = note.kind === 'emoji';
			dot.classList.toggle(DOT_LOCKED_CLASS, locked);
			dot.classList.toggle(DOT_REACTION_CLASS, isReaction && !locked);
			dot.classList.toggle(DOT_TEXT_CLASS, !isReaction && !locked);
			dot.setAttribute(
				'aria-label',
				locked
					? `Spoiler note at ${at}. Jump to just before it`
					: isReaction
						? `Reaction ${note.body} by ${who} at ${at}`
						: `Note by ${who} at ${at}. Open conversation`,
			);
			buildPreview(dot.querySelector('.' + PREVIEW_CLASS), note, who, locked, count);
		}
	}

	// A text Note opens on click/Enter/Space; a Reaction only exposes its
	// preview on hover/focus; a locked Spoiler performs Go here — it seeks to
	// just before its moment and plays, so the Note reveals through the natural
	// crossing. Its preview masks the body ("Spoiler") and it is still never
	// expanded while locked.
	function onDotActivate(dot) {
		const note = findNote(dot.dataset.ytbNoteId);
		if (!note) return;
		const video = document.querySelector('video');
		const locked = Boolean(note.spoiler) && video && Number(video.currentTime) < Number(note.timestamp);
		if (locked) {
			goHere(note);
			return;
		}
		if (note.kind === 'emoji') return;
		openPanel(note);
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
		// The Note's video timestamp, pinned in the top-right corner — replaces the
		// YouTube scrubber time suppressed while a dot/preview is hovered.
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
	 * Open (or replace) the Expanded Note for `note`. Never seeks: it pauses at
	 * the viewer's current position. Only the FIRST open of a chain acquires the
	 * pause lease; replacing one panel with another keeps the video paused and
	 * the original lease.
	 */
	async function openPanel(note) {
		const host = player();
		if (!host || !note) return;
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

		const panel = buildPanel(note, config);
		host.appendChild(panel);
		positionPanel(panel);
		panel.focus();
		dotFor(note.id)?.classList.add(DOT_OPEN_CLASS);

		startConversationPoll(panel);
		labelTimer = setInterval(() => refreshTimeLabels(panel), LABEL_REFRESH_MS);
	}

	function buildPanel(note, config) {
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name);
		const panel = document.createElement('section');
		panel.id = PANEL_ID;
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', `Note by ${who}`);
		panel.tabIndex = -1;

		// The Note text is the hero; the author renders small beneath it (own
		// authorship stays a neutral "You" via the stylesheet's muted default).
		const body = document.createElement('p');
		body.className = 'ytb-panel-body';
		body.textContent = note.body;

		const byline = document.createElement('div');
		byline.className = 'ytb-panel-byline';
		const author = document.createElement('span');
		author.className = 'ytb-panel-author';
		author.textContent = who;
		if (note.clientId !== myClientId) author.style.color = YTB.buddyColor(note.clientId);
		const posted = document.createElement('span');
		posted.className = 'ytb-rel ytb-panel-posted';
		posted.dataset.ytbCreatedAt = String(note.createdAt || Date.now());
		posted.dataset.ytbPrefix = 'Posted ';
		posted.textContent = 'Posted ' + YTB.relativeTime(Number(posted.dataset.ytbCreatedAt));
		byline.append(author, posted);

		// Note actions: Go here (always — it is local playback control), and the
		// author-only deemphasized delete with its in-panel confirmation.
		const actions = document.createElement('div');
		actions.className = 'ytb-panel-actions';
		const atLabel = YTB.formatTime(note.timestamp);
		const goHereButton = document.createElement('button');
		goHereButton.type = 'button';
		goHereButton.className = 'ytb-panel-gohere';
		goHereButton.setAttribute('aria-label', `Go here: play from just before ${atLabel}`);
		const goHereText = document.createElement('span');
		goHereText.textContent = 'Go here';
		const goHereTime = document.createElement('span');
		goHereTime.className = 'ytb-panel-gohere-time';
		goHereTime.textContent = '@' + atLabel;
		goHereButton.append(YTBTheme.icon('play'), goHereText, goHereTime);
		goHereButton.addEventListener('click', () => goHere(note));
		actions.append(goHereButton);

		const replies = document.createElement('div');
		replies.className = 'ytb-panel-replies';
		replies.setAttribute('aria-label', 'Replies');

		const replyArea = document.createElement('div');
		replyArea.className = 'ytb-panel-reply-area';

		const error = document.createElement('div');
		error.className = 'ytb-panel-error';
		error.setAttribute('role', 'status');

		panel.append(body, byline, actions, replies, replyArea, error);

		if (note.clientId === myClientId) {
			panel.append(buildDeleteConfirm(panel, note, actions));
		}

		// Keep panel interactions inside the panel (no player seeks/toggles).
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'click', 'dblclick']) {
			panel.addEventListener(type, (e) => e.stopPropagation());
		}
		panel.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				dismissPanel({ refocusDot: true });
			}
		});

		// Seed instantly from the last Room read, then poll for freshness.
		renderReplies(panel, repliesFor(note.id));
		updateReplyArea(panel, note, config.sharing, replyCount(note.id));
		refreshConversation(panel);
		return panel;
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
			author.textContent = reply.clientId === myClientId ? 'You' : YTB.buddyName(reply.clientId, reply.name);
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
			if (anchor + chrome + 64 + 16 > hostRect.height) {
				anchor = Math.max(12, hostRect.height - chrome - 64 - 16);
				panel.style.bottom = anchor + 'px';
			}
			const spare = hostRect.height - anchor - 16;
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

	// Manually resuming playback closes the panel (without re-pausing).
	document.addEventListener(
		'play',
		(event) => {
			if (!(event.target instanceof HTMLVideoElement)) return;
			if (document.getElementById(PANEL_ID)) {
				pauseLease = false;
				dismissPanel({ resume: false });
			}
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
		wrap.style.bottom = alertsBottomPx(host) + 'px';
		return wrap;
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

	function showNoteCard(note) {
		const wrap = alertsContainer();
		if (!wrap) return;
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name);
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
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name);
		const burst = document.createElement('div');
		burst.className = 'ytb-alert-burst';
		// Concurrent Reactions fan out horizontally instead of replacing.
		burst.style.setProperty('--ytb-fan', `${((burstCount++ % 5) - 2) * 48}px`);
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
		if (previousTime === null || video.seeking || currentTime <= previousTime || currentTime - previousTime > NATURAL_DELTA_SECONDS) {
			return;
		}
		for (const note of YTB.crossedNotes(notesForCurrentVideo(), previousTime, currentTime)) {
			if (note.kind === 'emoji') showReactionBurst(note);
			else showNoteCard(note);
		}
	}

	// ---------------------------------------------------------------------------
	// Wiring: pure consumer of content.js events; registered synchronously.
	// ---------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', (event) => {
		currentVideoId = (event.detail && event.detail.videoId) || null;
		lastPlaybackTime = null;
		burstCount = 0;
		dismissPanel({ resume: false });
		pauseLease = false;
		document.getElementById(ALERTS_ID)?.replaceChildren();
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
      .${DOT_CLASS} {
        position: absolute;
        top: 50%;
        width: 10px;
        height: 10px;
        margin: -5px 0 0 -5px;
        padding: 0;
        border: 1px solid rgba(0, 0, 0, 0.7);
        border-radius: 50%;
        box-sizing: border-box;
        background: #fff;
        z-index: 41;
        cursor: default;
      }
      .${DOT_TEXT_CLASS} { cursor: pointer; }
      .${DOT_CLASS}:focus-visible {
        outline: 2px solid var(--ytb-accent-500);
        outline-offset: 1px;
      }
      /* Locked Spoilers stay visually obscured but are click-to-seek (Go here). */
      .${DOT_LOCKED_CLASS} {
        filter: grayscale(1);
        opacity: 0.55;
        cursor: pointer;
      }
      .${DOT_LOCKED_CLASS}:hover, .${DOT_LOCKED_CLASS}:focus-visible { opacity: 0.85; }
      /* While a Note's panel is open, its own hover preview stays hidden. */
      .${DOT_OPEN_CLASS} .${PREVIEW_CLASS} { opacity: 0 !important; pointer-events: none !important; }

      /* --- Note Preview: opaque warm card (apricot system) --- */
      .${PREVIEW_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        transform: translateX(-50%);
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
        transition: opacity var(--ytb-dur-quick) var(--ytb-ease-out);
        z-index: 60;
      }
      /* Transparent hover bridge: spans the gap between the preview and the dot so
         the pointer can travel up onto the card without dropping :hover. It is
         interactive only while the dot is hovered, so it never blocks the
         scrubber; hovering it (a dot descendant) keeps .${DOT_CLASS}:hover alive. */
      .${PREVIEW_CLASS}::before {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        top: 100%;
        height: 22px;
        pointer-events: none;
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        opacity: 1;
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS}::before {
        pointer-events: auto;
      }
      .${DOT_TEXT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_TEXT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        pointer-events: auto;
        cursor: pointer;
      }
      /* Reactions keep the transparent over-video treatment (not a card). */
      .${PREVIEW_CLASS}.ytb-preview-reaction {
        border: 0;
        background: transparent;
        box-shadow: none;
        color: #fff;
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
      /* Suppress ONLY YouTube's native scrubber time while a dot/preview is
         hovered; its storyboard thumbnail (.ytp-tooltip-bg) is left intact. */
      .${SCRUB_HIDE_CLASS} .ytp-tooltip-text { visibility: hidden !important; }

      /* --- the Expanded Note: opaque warm surface (cream / espresso) --- */
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
        animation: ytb-pop-in var(--ytb-dur-base) var(--ytb-ease-spring);
      }
      #${PANEL_ID}:focus { outline: none; }
      @keyframes ytb-pop-in {
        from { opacity: 0; transform: scale(0.96) translateY(4px); }
      }
      .ytb-panel-body { margin: 0; font-size: 15px; line-height: 1.4; font-weight: 700; overflow-wrap: anywhere; }
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
      .ytb-panel-gohere-time { font-weight: 600; font-variant-numeric: tabular-nums; opacity: 0.72; }
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

      /* --- Playback Notifications --- */
      #${ALERTS_ID} {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2050;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        pointer-events: none;
      }
      .ytb-alert-card {
        pointer-events: auto;
        width: max-content;
        max-width: 260px;
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
        transform: translateX(var(--ytb-fan, 0));
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
        #${PANEL_ID}, .ytb-panel-confirm, .ytb-panel-reply.ytb-new { animation: none; }
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
