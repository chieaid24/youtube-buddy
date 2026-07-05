// extension/notes.js
//
// ALL Note & Reaction presentation on the watch page:
//   - Video Timeline dots (text Notes, Reactions, locked Spoilers), spread
//     apart when timestamps fall within 2 seconds so each keeps its own
//     pointer/keyboard target;
//   - hover/focus Note Previews (author, two-line body, Reply count);
//   - the Expanded Note: a pinned conversation panel with Replies, a Reply
//     composer, and the author-only delete confirmation;
//   - Playback Notifications: bottom-center note cards (~4s, clickable) and
//     animated Reaction bursts (~2s, non-interactive) on every NATURAL forward
//     crossing — rewind-and-replay triggers again, direct seeks stay silent.
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
	const PREVIEW_CLASS = 'ytb-note-preview';
	const PANEL_ID = 'ytb-note-panel';
	const ALERTS_ID = 'ytb-note-alerts';
	const STYLE_ID = 'ytb-notes-style';

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
				naturals.push({ id: note.id, timestamp, fraction: Math.max(0, Math.min(1, timestamp / duration)) });
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
				bar.appendChild(dot);
			}
			dot.style.left = ((fractions.get(id) || 0) * 100).toFixed(3) + '%';
			dot.style.background = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);

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
					? `Spoiler note at ${at}`
					: isReaction
						? `Reaction ${note.body} by ${who} at ${at}`
						: `Note by ${who} at ${at}. Open conversation`,
			);
			buildPreview(dot.querySelector('.' + PREVIEW_CLASS), note, who, locked, count);
		}
	}

	// A text Note opens on click/Enter/Space; a Reaction only exposes its
	// preview on hover/focus; a locked Spoiler does nothing until unlocked.
	function onDotActivate(dot) {
		const note = findNote(dot.dataset.ytbNoteId);
		if (!note || note.kind === 'emoji') return;
		const video = document.querySelector('video');
		const locked = Boolean(note.spoiler) && video && Number(video.currentTime) < Number(note.timestamp);
		if (locked) return;
		openPanel(note);
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
		if (locked) {
			const label = document.createElement('div');
			label.className = 'ytb-preview-spoiler';
			label.textContent = 'Spoiler';
			preview.append(label);
			return;
		}
		if (note.kind === 'emoji') {
			// Transparent treatment: just the larger emoji and the author.
			const emoji = document.createElement('div');
			emoji.className = 'ytb-preview-emoji';
			emoji.textContent = note.body;
			const author = document.createElement('div');
			author.className = 'ytb-preview-emoji-author';
			author.textContent = who;
			preview.append(emoji, author);
			return;
		}
		const author = document.createElement('div');
		author.className = 'ytb-preview-author';
		author.textContent = who;
		author.style.color = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);
		const body = document.createElement('div');
		body.className = 'ytb-preview-body';
		body.textContent = note.body;
		preview.append(author, body);
		if (count > 0) {
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
		if (openNote !== note) return; // replaced while awaiting config

		const panel = buildPanel(note, config);
		host.appendChild(panel);
		positionPanel(panel);
		panel.focus();

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

		const author = document.createElement('div');
		author.className = 'ytb-panel-author';
		author.textContent = who;
		author.style.color = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);

		const body = document.createElement('p');
		body.className = 'ytb-panel-body';
		body.textContent = note.body;

		const meta = document.createElement('div');
		meta.className = 'ytb-panel-meta';
		const at = document.createElement('span');
		at.textContent = `At ${YTB.formatTime(note.timestamp)} in video`;
		const posted = document.createElement('span');
		posted.className = 'ytb-rel';
		posted.dataset.ytbCreatedAt = String(note.createdAt || Date.now());
		posted.dataset.ytbPrefix = 'Posted ';
		posted.textContent = 'Posted ' + YTB.relativeTime(Number(posted.dataset.ytbCreatedAt));
		meta.append(at, posted);

		const replies = document.createElement('div');
		replies.className = 'ytb-panel-replies';
		replies.setAttribute('aria-label', 'Replies');

		const replyArea = document.createElement('div');
		replyArea.className = 'ytb-panel-reply-area';

		const error = document.createElement('div');
		error.className = 'ytb-panel-error';
		error.setAttribute('role', 'status');

		panel.append(author, body, meta, replies, replyArea, error);

		// Author-only, deemphasized delete with an in-panel confirmation.
		if (note.clientId === myClientId) {
			panel.append(buildDeleteFooter(panel, note));
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

	function buildDeleteFooter(panel, note) {
		const footer = document.createElement('div');
		footer.className = 'ytb-panel-footer';

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'ytb-panel-delete';
		remove.textContent = 'Delete note';

		const confirm = document.createElement('div');
		confirm.className = 'ytb-panel-confirm';
		confirm.hidden = true;

		const text = document.createElement('p');
		text.className = 'ytb-panel-confirm-text';

		const actions = document.createElement('div');
		actions.className = 'ytb-panel-confirm-actions';
		const yes = document.createElement('button');
		yes.type = 'button';
		yes.className = 'ytb-panel-confirm-delete';
		yes.textContent = 'Delete';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'ytb-panel-confirm-cancel';
		cancel.textContent = 'Cancel';
		actions.append(yes, cancel);
		confirm.append(text, actions);

		remove.addEventListener('click', () => {
			const count = replyCount(note.id);
			text.textContent =
				'Really delete your note? No Buddy will be able to see it.' +
				(count > 0 ? ` This will also delete ${count === 1 ? '1 reply' : `${count} replies`}.` : '');
			confirm.hidden = false;
			remove.hidden = true;
			yes.focus();
		});
		cancel.addEventListener('click', () => {
			confirm.hidden = true;
			remove.hidden = false;
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

		footer.append(remove, confirm);
		return footer;
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

	/** Rebuild the Reply list (oldest → newest), keeping a bottom-pinned scroll. */
	function renderReplies(panel, replies) {
		const wrap = panel.querySelector('.ytb-panel-replies');
		if (!wrap) return;
		const pinned = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 24;
		wrap.replaceChildren();
		for (const reply of replies) {
			const row = document.createElement('div');
			row.className = 'ytb-panel-reply';
			const head = document.createElement('div');
			head.className = 'ytb-panel-reply-head';
			const author = document.createElement('span');
			author.className = 'ytb-panel-reply-author';
			author.textContent = reply.clientId === myClientId ? 'You' : YTB.buddyName(reply.clientId, reply.name);
			author.style.color = reply.clientId === myClientId ? '#fff' : YTB.buddyColor(reply.clientId);
			const when = document.createElement('span');
			when.className = 'ytb-rel ytb-panel-reply-time';
			when.dataset.ytbCreatedAt = String(reply.createdAt || Date.now());
			when.dataset.ytbPrefix = '';
			when.textContent = YTB.relativeTime(Number(when.dataset.ytbCreatedAt));
			head.append(author, when);
			const body = document.createElement('p');
			body.className = 'ytb-panel-reply-body';
			body.textContent = reply.body;
			row.append(head, body);
			wrap.append(row);
		}
		if (pinned) wrap.scrollTop = wrap.scrollHeight;
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

		const textarea = document.createElement('textarea');
		textarea.className = 'ytb-panel-reply-input';
		textarea.maxLength = YTB.NOTE_MAX_CHARS;
		textarea.rows = 1;
		textarea.placeholder = 'Reply...';
		textarea.setAttribute('aria-label', 'Write a reply');
		textarea.addEventListener('input', () => autosize(textarea));
		textarea.addEventListener('keydown', (event) => {
			event.stopPropagation(); // never feed YouTube's player hotkeys
			if (event.key === 'Escape') {
				dismissPanel({ refocusDot: true });
				return;
			}
			// Enter posts; Shift+Enter inserts a newline.
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				submitReply(panel, note, textarea);
			}
		});
		area.append(textarea);
	}

	async function submitReply(panel, note, textarea) {
		const body = textarea.value.trim();
		if (!body || pendingReply) return; // no duplicate submission while pending
		pendingReply = true;
		textarea.disabled = true;
		const error = panel.querySelector('.ytb-panel-error');
		error.textContent = '';

		const clientId = await YTB.ensureClientId();
		const { name } = await YTB.getConfig();
		const result = await YTB.postReply({ clientId, name, noteId: note.id, body });
		pendingReply = false;
		textarea.disabled = false;

		if (result.ok) {
			// Success appends immediately, oldest → newest, without closing.
			textarea.value = '';
			autosize(textarea);
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

		// Never taller than the player: the Reply list absorbs the squeeze.
		const replies = panel.querySelector('.ytb-panel-replies');
		if (replies) {
			const spare = hostRect.height - parseFloat(panel.style.bottom) - 16;
			replies.style.maxHeight = Math.max(64, Math.min(180, spare - 170)) + 'px';
		}
	}

	function removePanel() {
		stopConversationPoll();
		document.getElementById(PANEL_ID)?.remove();
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
		const author = document.createElement('div');
		author.className = 'ytb-alert-author';
		author.textContent = who;
		author.style.color = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);
		const body = document.createElement('div');
		body.className = 'ytb-alert-body';
		body.textContent = note.body;
		card.append(author, body);
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
        outline: 2px solid #3ea6ff;
        outline-offset: 1px;
      }
      .${DOT_LOCKED_CLASS} {
        filter: grayscale(1);
        opacity: 0.55;
      }
      .${PREVIEW_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        transform: translateX(-50%);
        width: max-content;
        max-width: 240px;
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.88);
        color: #fff;
        font: 12px/1.35 Roboto, Arial, sans-serif;
        text-align: left;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.1s;
        z-index: 60;
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        opacity: 1;
      }
      .${DOT_TEXT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_TEXT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        pointer-events: auto;
        cursor: pointer;
      }
      .${PREVIEW_CLASS}.ytb-preview-reaction {
        background: transparent;
        text-align: center;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
      }
      .ytb-preview-author { font-weight: 600; margin-bottom: 2px; }
      .ytb-preview-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: #e8e8e8;
        overflow-wrap: anywhere;
      }
      .ytb-preview-replies { margin-top: 4px; color: #3ea6ff; font-weight: 500; }
      .ytb-preview-spoiler { color: #aaa; font-style: italic; }
      .ytb-preview-emoji { font-size: 26px; line-height: 1.1; }
      .ytb-preview-emoji-author { margin-top: 2px; color: #eee; font-size: 11px; }

      #${PANEL_ID} {
        position: absolute;
        z-index: 2100;
        box-sizing: border-box;
        padding: 12px 14px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        background: #212121;
        color: #fff;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
        font: 13px/1.4 Roboto, Arial, sans-serif;
        text-align: left;
      }
      #${PANEL_ID}:focus { outline: none; }
      .ytb-panel-author { font-weight: 600; font-size: 14px; }
      .ytb-panel-body { margin: 6px 0 4px; overflow-wrap: anywhere; }
      .ytb-panel-meta {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
        color: #aaa;
        font-size: 11px;
      }
      .ytb-panel-replies {
        max-height: 180px;
        overflow-y: auto;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }
      .ytb-panel-replies:empty { border-top: 0; }
      .ytb-panel-reply { padding: 7px 0 2px; }
      .ytb-panel-reply-head { display: flex; justify-content: space-between; gap: 8px; }
      .ytb-panel-reply-author { font-weight: 600; font-size: 12px; }
      .ytb-panel-reply-time { color: #aaa; font-size: 11px; }
      .ytb-panel-reply-body { margin: 2px 0 0; color: #e8e8e8; overflow-wrap: anywhere; }
      .ytb-panel-reply-area { margin-top: 8px; }
      .ytb-panel-reply-input {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 9px;
        border: 1px solid #555;
        border-radius: 6px;
        background: #181818;
        color: #fff;
        font: inherit;
        resize: none;
        overflow: hidden;
      }
      .ytb-panel-reply-input:focus { border-color: #3ea6ff; outline: none; }
      .ytb-panel-reply-note { margin: 4px 0 0; color: #aaa; font-size: 12px; }
      .ytb-panel-error { min-height: 16px; margin-top: 6px; color: #ff8a80; font-size: 12px; }
      .ytb-panel-footer { margin-top: 4px; }
      .ytb-panel-delete {
        padding: 0;
        border: 0;
        background: transparent;
        color: #888;
        font: 12px Roboto, Arial, sans-serif;
        cursor: pointer;
      }
      .ytb-panel-delete:hover, .ytb-panel-delete:focus-visible { color: #ff8a80; text-decoration: underline; outline: none; }
      .ytb-panel-confirm-text { margin: 6px 0; color: #fff; }
      .ytb-panel-confirm-actions { display: flex; gap: 8px; }
      .ytb-panel-confirm-delete {
        padding: 5px 12px;
        border: 0;
        border-radius: 14px;
        background: #d93025;
        color: #fff;
        font: 600 12px Roboto, Arial, sans-serif;
        cursor: pointer;
      }
      .ytb-panel-confirm-cancel {
        padding: 5px 12px;
        border: 1px solid #555;
        border-radius: 14px;
        background: transparent;
        color: #fff;
        font: 600 12px Roboto, Arial, sans-serif;
        cursor: pointer;
      }
      .ytb-panel-confirm-delete:disabled, .ytb-panel-confirm-cancel:disabled { opacity: 0.5; cursor: default; }
      .ytb-panel-confirm-delete:focus-visible, .ytb-panel-confirm-cancel:focus-visible { outline: 2px solid #3ea6ff; }

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
        padding: 8px 12px;
        border: 0;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font: 12px/1.35 Roboto, Arial, sans-serif;
        text-align: left;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        cursor: pointer;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.25s, transform 0.25s;
      }
      .ytb-alert-card.show { opacity: 1; transform: translateY(0); }
      .ytb-alert-card:focus-visible { outline: 2px solid #3ea6ff; }
      .ytb-alert-author { font-weight: 600; margin-bottom: 1px; }
      .ytb-alert-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: #e8e8e8;
        overflow-wrap: anywhere;
      }
      .ytb-alert-burst {
        pointer-events: none;
        text-align: center;
        transform: translateX(var(--ytb-fan, 0));
        animation: ytb-burst ${REACTION_BURST_MS}ms ease-out forwards;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
      }
      .ytb-alert-burst-emoji { font-size: 34px; line-height: 1.1; }
      .ytb-alert-burst-author { color: #fff; font: 11px Roboto, Arial, sans-serif; }
      @keyframes ytb-burst {
        0%   { opacity: 0; translate: 0 10px; }
        15%  { opacity: 1; translate: 0 0; }
        70%  { opacity: 1; translate: 0 -18px; }
        100% { opacity: 0; translate: 0 -30px; }
      }
    `;
		(document.head || document.documentElement).appendChild(style);
	}
})();
