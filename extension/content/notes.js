// extension/content/notes.js
// Note/Reaction presentation on the watch page: Timeline dots, Note Previews,
// the Expanded Note panel, Playback Notification triggers, Unseen pulses
// (ADR-0010; CONTEXT.md). Renders/Acknowledges nothing while Notes off.
// Class names + stylesheet in notes-style.js; notification stack in
// notes-alerts.js; theme.js isolates Reply-textarea keys as `ytb:keydown`.
// Pure consumer (ADR-0001): content.js owns nav/mutation, renderer.js owns
// Room polling (`ytb:room-data`), composer.js hands posts via `ytb:note-posted`.

(function () {
	'use strict';

	const {
		DOT_CLASS,
		DOT_TEXT_CLASS,
		DOT_REACTION_CLASS,
		DOT_LOCKED_CLASS,
		DOT_OPEN_CLASS,
		DOT_UNSEEN_CLASS,
		DOT_PASSED_CLASS,
		CLUSTER_CLASS,
		CLUSTER_PINNED_CLASS,
		TOOLTIP_SUPPRESSED_CLASS,
		PREVIEW_CLASS,
		PANEL_ID,
	} = YTBNotesUI.NAMES;

	// Note Band geometry (#173) lives in shared-geometry.js so dotHitReaches/
	// panelBarClearance derive from the same numbers the stylesheet uses.
	const BAND = YTB.NOTE_BAND;
	const DOT_DIAMETER = BAND.dotDiameter; // drives clustering + clamp
	const LAYOUT_UNITS_PER_PX = 64; // Chromium's subpixel layout grid
	const CLUSTER_FAN_GAP = 14; // px - the Fan Gap's IDEAL; shrinks toward DOT_DIAMETER on a crowded bar

	const CONVERSATION_POLL_MS = 5000; // focused Expanded Note freshness
	const LABEL_REFRESH_MS = 30_000; // "Posted 8 min ago" recomputation
	// Steps larger than this between timeupdates are seeks, not playback.
	const NATURAL_DELTA_SECONDS = 2;

	// --- state ---
	let myClientId = null;
	let activeRoomCode = '';
	let notesByVideoId = new Map(); // videoId -> Note[] (mine and Buddies')
	let repliesByNoteId = new Map(); // noteId -> Reply[] oldest-first
	let roster = []; // full Room roster (incl. me), for Room-unique Buddy labels
	let currentVideoId = null;
	let lastPlaybackTime = null; // previous timeupdate, for natural crossings
	// Unseen state (ADR-0010): seenSet mirrors the persisted list; unseenDotIds
	// is the derived pulse set, synchronous so renderDots never awaits storage.
	let seenSet = new Set();
	let unseenDotIds = new Set();

	// pauseLease: true iff OPENING (the first of a replacement chain) paused a
	// playing video, so dismissal knows to resume.
	let openNote = null;
	let pauseLease = false;
	let panelPressOrigin = 'elsewhere'; // capture-time origin for the next click (ADR-0011)
	let pollTimer = null;
	let labelTimer = null;
	let pendingReply = false;
	let pendingDelete = false;
	// A Room Feed row may record a video to pause on arrival (ADR-0010),
	// consumed on that video's first Room read iff an Unseen dot is on it.
	let pendingArrival = null;
	let notesHidden = false; // Notes Visibility off: zero Note UI on the player

	// Controls Hold state (CONTEXT.md): dots swallow the pointer events that keep
	// YouTube's chrome awake, so YTB.controlsHold re-feeds its timer while a Note
	// surface is engaged. Keyed by Cluster wrapper; sweepControlsHolds catches
	// wrappers that left the DOM without a mouseleave/focusout so a hold can't leak.
	const holdBySurface = new Map(); // wrapper Element -> { hover: release|null, focus: release|null }
	let panelHoldRelease = null; // teardown for the Expanded Note's hover-scoped hold

	const alerts = YTBNoteAlerts.create({
		getPlayer: player,
		authorFor: (note) => ({
			who: note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster),
			foreign: note.clientId !== myClientId,
		}),
		onOpen: openPanel,
	});

	YTBNotesUI.injectStyle();

	YTB.getSettings().then((settings) => {
		notesHidden = settings.notesHidden;
		alerts.setPosition(settings.notificationPosition);
		renderDots();
	});

	// Read any arrival a Room Feed row left before this script (re)loaded; SPA
	// nav never reloads this script, so the onChanged mirror picks up the write.
	YTB.getPendingArrival().then((arrival) => {
		pendingArrival = arrival;
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !YTB.isContextActive()) return;
		if (changes.notesHidden) {
			notesHidden = changes.notesHidden.newValue === true;
			if (notesHidden) {
				dismissPanel(); // dismissal semantics: lease-aware resume
				alerts.reset();
			}
			renderDots(); // reconciles to zero dots when hidden, back when shown
		}
		if (changes.notificationPosition) {
			alerts.setPosition(changes.notificationPosition.newValue); // live re-anchor
		}
		if ('pendingArrival' in changes) {
			const next = changes.pendingArrival.newValue;
			// Mirror only; the decision waits for this video's Room read.
			pendingArrival = next && next.videoId ? next : null;
		}
	});

	// -------------------------------------------------------------------------
	// Data intake: Room broadcasts, immediate post reconciliation.
	// -------------------------------------------------------------------------

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
	});

	// -------------------------------------------------------------------------
	// Unseen state (ADR-0010): the pulse set and the three Acknowledge triggers.
	// -------------------------------------------------------------------------

	// The Room-read shape the pure Unseen helpers take, rebuilt from the maps so
	// local appends reflect immediately without waiting for the next Room poll.
	function currentRecords() {
		return {
			notes: [...notesByVideoId.values()].flat(),
			replies: [...repliesByNoteId.values()].flat(),
		};
	}

	function recomputeUnseen() {
		unseenDotIds = myClientId ? new Set(YTB.unseenNoteIds(currentRecords(), myClientId, seenSet)) : new Set();
	}

	// Reload (and prune) the seen set after a Room read, then derive the pulse
	// set. Pruning only follows a SUCCESSFUL read - a failed GET's empty arrays
	// would resurrect every Acknowledged pulse.
	async function syncSeenState(detail) {
		const code = activeRoomCode;
		if (!code || !myClientId) {
			seenSet = new Set();
			unseenDotIds = new Set();
			tryPendingArrival(); // no Room: consume the handshake without pausing
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
		tryPendingArrival(); // arrival pause depends on the Unseen set just computed
	}

	// Acknowledge one Note Dot: clears every Unseen item anchored to it (Mention
	// + Unseen Replies) at once and stops its pulse for good.
	function acknowledgeDot(noteId) {
		if (notesHidden || !noteId || !unseenDotIds.has(noteId)) return;
		const ids = YTB.acknowledgeTargets(currentRecords(), myClientId, noteId);
		if (ids.length === 0) return;
		for (const id of ids) seenSet.add(id);
		unseenDotIds.delete(noteId);
		YTB.markSeen(activeRoomCode, ids); // best-effort persist; the in-memory set already stopped the pulse
		renderDots();
	}

	// unseenDotIds is Room-wide; scope to the current video for the arrival pause.
	function hasUnseenDotOnCurrentVideo() {
		for (const note of notesForCurrentVideo()) {
			if (unseenDotIds.has(note.id)) return true;
		}
		return false;
	}

	// A Room Feed row asked to pause on arrival iff something is Unseen
	// (ADR-0010). Consume the one-shot handshake now regardless of outcome (so it
	// never refires), then pause only when Notes are visible AND a dot is Unseen.
	function tryPendingArrival() {
		const arrival = pendingArrival;
		if (!arrival) return;
		if (Date.now() - (Number(arrival.at) || 0) > YTB.PENDING_ARRIVAL_TTL_MS) {
			clearPendingArrival();
			return;
		}
		if (arrival.videoId !== currentVideoId) return; // still en route, or for another video
		clearPendingArrival();
		if (notesHidden || !hasUnseenDotOnCurrentVideo()) return;
		const video = document.querySelector('video');
		if (!video) return;
		// Pause at the viewer's own place and hold through autoplay settling; the
		// Unseen dot(s) pulse, and the viewer chooses which to open.
		YTB.startArrivalGrace();
		if (!video.paused) video.pause();
	}

	function clearPendingArrival() {
		pendingArrival = null;
		YTB.clearPendingArrival();
	}

	// Buddy Color re-assignment (#115): renderDots repaints dots + Previews; the
	// open Expanded Note is separate DOM, so restyle its stamped author spans in
	// place (keeps scroll position and pause lease).
	document.addEventListener('ytb:buddy-colors', () => {
		renderDots();
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		for (const span of panel.querySelectorAll('[data-ytb-color-cid]')) {
			span.style.color = YTB.buddyTextColor(span.dataset.ytbColorCid);
		}
	});

	// composer.js posted a Note/Reaction: insert into the Timeline immediately
	// (no 60s Room-poll wait), then fire its Post Echo.
	document.addEventListener('ytb:note-posted', (event) => {
		const note = event.detail && event.detail.note;
		if (!note || !note.id || !note.videoId) return;
		myClientId = myClientId || note.clientId;
		const list = notesByVideoId.get(note.videoId) || [];
		if (!list.some((existing) => existing.id === note.id)) list.push(note);
		notesByVideoId.set(note.videoId, list);
		renderDots();
		postEcho(note);
	});

	// Post Echo: the author's own Playback Notification, fired the instant they
	// post - the second trigger alongside a natural crossing. Rebases the crossing
	// window past the Note's timestamp so the composer's resume can't replay it.
	function postEcho(note) {
		// Guard, not a live path: composer.js removes the + button while Notes off.
		if (notesHidden || note.videoId !== currentVideoId) return;
		const timestamp = Number(note.timestamp);
		if (Number.isFinite(timestamp)) {
			lastPlaybackTime = lastPlaybackTime === null ? timestamp : Math.max(lastPlaybackTime, timestamp);
		}
		alerts.enqueue(note, 'echo');
	}

	// -------------------------------------------------------------------------
	// Video Timeline dots + Note Previews.
	// -------------------------------------------------------------------------

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
		sweepControlsHolds(); // a wrapper YouTube detached must not hold the chrome awake
		const bar = document.querySelector('.ytp-progress-bar');
		const video = document.querySelector('video');
		if (!bar) return; // player not built yet - a later ytb:mutation retries

		const duration = video ? Number(video.duration) : NaN;
		const playhead = video ? Number(video.currentTime) : 0;
		const desired = new Map(); // id -> { note, locked, passed, timestamp }
		// Notes off: desired stays empty, so the reconciliation strips every dot.
		if (!notesHidden && Number.isFinite(duration) && duration > 0) {
			for (const note of notesForCurrentVideo()) {
				const timestamp = Number(note.timestamp);
				if (!Number.isFinite(timestamp)) continue;
				desired.set(note.id, {
					note,
					// Spoiler follows the playhead; relocks when revisited from earlier.
					locked: Boolean(note.spoiler) && playhead < timestamp,
					passed: playhead >= timestamp,
					timestamp,
				});
			}
		}

		// Dots nest under Cluster wrappers, so index the whole bar by id.
		const existing = new Map();
		for (const dot of bar.querySelectorAll('.' + DOT_CLASS)) {
			const id = dot.dataset.ytbNoteId;
			if (desired.has(id)) existing.set(id, dot);
			else dot.remove();
		}
		if (desired.size === 0) {
			for (const wrapper of bar.querySelectorAll('.' + CLUSTER_CLASS)) {
				releaseControlsHolds(wrapper);
				wrapper.remove();
			}
			return;
		}
		if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';

		// Each dot's exact moment through YouTube's own chapter geometry (#159),
		// re-measured every render so late chapters/resize/fullscreen re-align.
		// Never displaced at rest: co-timed dots overlap, fanning apart on hover.
		const ids = [...desired.keys()];
		const barWidth = bar.getBoundingClientRect().width || 0;
		const segments = YTB.barSegments(bar);
		const px = ids.map(
			(id) => Math.round(YTB.timeToX(segments, desired.get(id).timestamp, duration) * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX,
		);

		// Solve the fan for the WHOLE bar in one go (#162), recomputed every render.
		const { clusters, offsets } = YTB.solveDotFan(px, {
			idealGap: CLUSTER_FAN_GAP,
			barWidth,
			dotDiameter: DOT_DIAMETER,
		});

		const hitReaches = YTB.dotHitReaches(px, BAND.dotDiameter, BAND.hitMaxSideReach);

		// Reconcile Cluster wrappers keyed by exact membership: a steady poll
		// reuses each wrapper (re-parenting a dot would restart its Unseen
		// pulse); only a Note added/removed rebuilds the affected wrapper.
		const byKey = new Map();
		for (const wrapper of bar.querySelectorAll('.' + CLUSTER_CLASS)) byKey.set(wrapper.dataset.ytbClusterKey, wrapper);
		const wanted = new Set();

		for (const cluster of clusters) {
			const memberIds = cluster.map((i) => ids[i]);
			const memberPx = cluster.map((i) => px[i]);
			const key = memberIds.join('|'); // members already sorted by x (== by timestamp)
			wanted.add(key);

			let wrapper = byKey.get(key);
			if (!wrapper) {
				wrapper = document.createElement('div');
				wrapper.className = CLUSTER_CLASS;
				wrapper.dataset.ytbClusterKey = key;
				// Swallow press/hover over the keeper (the fan's gaps) like the dots
				// do, so YouTube pops no storyboard/time pill behind the fan.
				for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mousemove', 'mouseover']) {
					wrapper.addEventListener(type, (e) => e.stopPropagation());
				}
				// Hide any storyboard YouTube showed crossing the scrubber; restore on leave.
				wrapper.addEventListener('mouseenter', () => setStoryboardSuppressed(wrapper, true));
				wrapper.addEventListener('mouseleave', () => setStoryboardSuppressed(wrapper, false));
				bindControlsHold(wrapper);
				bar.appendChild(wrapper);
			}
			// Anchor at the Cluster centre in bar px (chapter geometry has no fixed
			// percentage); members sit at their true offset from that centre, with
			// the fan as a hover-only transform on top.
			const center = Math.round(((memberPx[0] + memberPx[memberPx.length - 1]) / 2) * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX;
			wrapper.style.left = center + 'px';

			let halfExtent = 0;
			memberIds.forEach((id, k) => {
				const basePx = memberPx[k] - center;
				const fan = offsets[cluster[k]]; // solved for the whole bar, read per dot
				const dot = existing.get(id) || buildDot(id);
				if (dot.parentElement !== wrapper) wrapper.appendChild(dot);
				const hitReach = hitReaches[cluster[k]];
				const hitLeft = Math.floor(hitReach.left * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX;
				const hitRight = Math.floor(hitReach.right * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX;
				dot.style.setProperty('--ytb-hit-left', hitLeft + 'px');
				dot.style.setProperty('--ytb-hit-right', hitRight + 'px');
				dot.style.setProperty('--ytb-hit-height', hitLeft || hitRight ? BAND.hitHeight + 'px' : '0px');
				dot.style.left = basePx + 'px';
				dot.style.setProperty('--ytb-fan', fan.toFixed(2) + 'px');
				updateDot(dot, id, desired.get(id));
				halfExtent = Math.max(halfExtent, Math.abs(basePx + fan));
			});
			// The hover-keeper spans the fanned band so the pointer can cross the
			// gaps the fan opens without collapsing it.
			wrapper.style.setProperty('--ytb-fan-extent', (2 * (halfExtent + DOT_DIAMETER / 2)).toFixed(2) + 'px');
			// A Cluster with an open Expanded Note stays fanned, so the anchor dot
			// never slides out from under the panel.
			wrapper.classList.toggle(CLUSTER_PINNED_CLASS, Boolean(openNote) && memberIds.includes(openNote.id));
		}

		// Drop wrappers whose membership no longer exists; surviving dots were
		// already moved into the new wrapper above, so only empties remain.
		for (const [key, wrapper] of byKey) {
			if (!wanted.has(key)) {
				releaseControlsHolds(wrapper);
				wrapper.remove();
			}
		}
	}

	/** Toggle YouTube's storyboard/time-pill visibility on this wrapper's player. */
	function setStoryboardSuppressed(wrapper, suppressed) {
		const player = wrapper.closest('#movie_player, .html5-video-player');
		if (player) player.classList.toggle(TOOLTIP_SUPPRESSED_CLASS, suppressed);
	}

	// Controls Hold wiring for one Cluster wrapper: mouseenter/leave and
	// focusin/out bubble from the whole subtree (dots + Previews), so one
	// binding covers every engagement; pointer and keyboard hold independently.
	function bindControlsHold(wrapper) {
		const holds = { hover: null, focus: null };
		holdBySurface.set(wrapper, holds);
		wrapper.addEventListener('mouseenter', () => {
			holds.hover ||= YTB.controlsHold.acquire();
		});
		wrapper.addEventListener('mouseleave', () => {
			holds.hover?.();
			holds.hover = null;
		});
		wrapper.addEventListener('focusin', () => {
			holds.focus ||= YTB.controlsHold.acquire();
		});
		wrapper.addEventListener('focusout', () => {
			holds.focus?.();
			holds.focus = null;
		});
	}

	/** Release (idempotently) and forget one wrapper's Controls Holds. */
	function releaseControlsHolds(wrapper) {
		const holds = holdBySurface.get(wrapper);
		if (!holds) return;
		holds.hover?.();
		holds.focus?.();
		holdBySurface.delete(wrapper);
	}

	// Runs every renderDots pass, so a leaked hold lives one render at most.
	function sweepControlsHolds() {
		for (const wrapper of [...holdBySurface.keys()]) {
			if (!wrapper.isConnected) releaseControlsHolds(wrapper);
		}
	}

	/** One-time construction of a Note Dot button, its Preview, and listeners. */
	function buildDot(id) {
		const dot = document.createElement('button');
		dot.type = 'button';
		dot.className = DOT_CLASS;
		dot.dataset.ytbNoteId = id;
		const preview = dot.appendChild(document.createElement('div'));
		preview.className = PREVIEW_CLASS;
		// Never let the player read a dot press as a seek; clicking opens the
		// Expanded Note (Go here is the only seek). Hover is swallowed too, so
		// YouTube pops no storyboard/time pill behind the Preview.
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mousemove', 'mouseover']) {
			dot.addEventListener(type, (e) => e.stopPropagation());
		}
		dot.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			onDotActivate(dot);
		});
		// Hover and keyboard focus both Acknowledge (ADR-0010) and unfold the
		// Preview, so each also clamps it inside the player first (#181).
		dot.addEventListener('mouseenter', () => {
			clampPreview(dot);
			acknowledgeDot(dot.dataset.ytbNoteId);
		});
		dot.addEventListener('focus', () => {
			clampPreview(dot);
			acknowledgeDot(dot.dataset.ytbNoteId);
		});
		return dot;
	}

	// Slide a Note Preview back inside the player's edges before it unfolds
	// (#181): sets --ytb-preview-shift only when the card would spill past
	// positionPanel's 8px inset; the paired transform-origin and ::before bridge
	// read the same variable, so a shifted card still grows out of its dot.
	function clampPreview(dot) {
		const preview = dot.querySelector('.' + PREVIEW_CLASS);
		const host = player();
		if (!preview || !host) return;
		const hostRect = host.getBoundingClientRect();
		const dotRect = dot.getBoundingClientRect();
		const center = dotRect.left + dotRect.width / 2;
		const half = preview.offsetWidth / 2; // untransformed layout width, scale-independent
		const inset = 8; // matches positionPanel's player-edge inset
		const overLeft = hostRect.left + inset - (center - half);
		const overRight = center + half - (hostRect.right - inset);
		let shift = 0;
		if (overLeft > 0)
			shift = overLeft; // near the start: push right
		else if (overRight > 0) shift = -overRight; // near the end: pull left
		preview.style.setProperty('--ytb-preview-shift', shift.toFixed(2) + 'px');
	}

	/** Reconcile one Note Dot's colour, state classes, label, and Preview. */
	function updateDot(dot, id, { note, locked, passed }) {
		const color = note.clientId === myClientId ? '#fff' : YTB.buddyColor(note.clientId);
		dot.style.background = color;
		// The open Note's own hover preview is redundant next to its panel.
		dot.classList.toggle(DOT_OPEN_CLASS, Boolean(openNote) && openNote.id === id);
		// Unseen dots pulse until Acknowledged (ADR-0010); outranks the passed paint.
		const unseen = unseenDotIds.has(id);
		dot.classList.toggle(DOT_UNSEEN_CLASS, unseen);
		dot.classList.toggle(DOT_PASSED_CLASS, passed && !unseen);

		const count = replyCount(id);
		// The resolved paint color is part of the signature: a Buddy Color
		// re-assignment (#115) must rebuild the retained dot's Note Preview,
		// whose author name carries the color inline.
		const signature = JSON.stringify([locked, passed, unseen, note.kind, note.clientId, note.name, note.body, count, color]);
		if (dot.dataset.ytbSig === signature) return;
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

	// Activating any Note Dot/Preview opens its Expanded Note without seeking (routing: YTB.dotActivation).
	function onDotActivate(dot) {
		const note = findNote(dot.dataset.ytbNoteId);
		if (!note) return;
		if (YTB.dotActivation(note).action === 'open') openPanel(note);
	}

	// Go here: seek just before the Note and resume, so it reveals via its own
	// Playback Notification on the natural crossing. Local-only.
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
		// Corner timestamp (the dot swallows hover, so YouTube shows no time pill).
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
		// Text Note: body, author, Reply count; a locked Spoiler masks the body
		// and withholds the count.
		const body = document.createElement('div');
		body.className = locked ? 'ytb-preview-spoiler' : 'ytb-preview-body';
		body.textContent = locked ? 'Spoiler' : note.body;
		const author = document.createElement('div');
		author.className = 'ytb-preview-author';
		author.textContent = who;
		if (note.clientId !== myClientId) author.style.color = YTB.buddyTextColor(note.clientId);
		preview.append(body, author);
		if (!locked && count > 0) {
			const replies = document.createElement('div');
			replies.className = 'ytb-preview-replies';
			replies.textContent = count === 1 ? '1 reply' : `${count} replies`;
			preview.append(replies);
		}
	}

	// -------------------------------------------------------------------------
	// Expanded Note: the pinned conversation panel.
	// -------------------------------------------------------------------------

	function player() {
		return document.querySelector('#movie_player');
	}

	function dotFor(noteId) {
		const bar = document.querySelector('.ytp-progress-bar');
		if (!bar) return null;
		for (const dot of bar.querySelectorAll('.' + DOT_CLASS)) {
			if (dot.dataset.ytbNoteId === noteId) return dot;
		}
		return null;
	}

	// The rectangle the Expanded Note grows out of: the hovered Preview card if
	// one is on screen, else the dot itself. Null when there is no dot.
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

	// Grow the already-positioned panel out of `sourceRect` with a FLIP (the Web
	// Animations API auto-clears the transform, leaving nothing for
	// positionPanel to re-clamp). prefers-reduced-motion collapses to an opacity
	// fade; no source falls back to a small scale-up.
	function flipPanelOpen(panel, sourceRect) {
		if (!panel.isConnected || typeof panel.animate !== 'function') return;
		const tokens = getComputedStyle(document.documentElement);
		const duration = cssDurationMs(tokens.getPropertyValue('--ytb-dur-base'), 200);
		const spring = tokens.getPropertyValue('--ytb-ease-spring').trim() || 'ease-out';

		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			panel.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration,
				easing: 'linear',
			});
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
				{
					transformOrigin: 'top left',
					transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
					opacity: 0,
				},
				{ transformOrigin: 'top left', transform: 'none', opacity: 1 },
			],
			{ duration, easing: spring },
		);
	}

	// Open (or replace) the Expanded Note. Never seeks: it pauses at the
	// viewer's current position. Only the FIRST open of a chain acquires the
	// pause lease; replacing one panel with another keeps the original lease.
	async function openPanel(note) {
		const host = player();
		if (!host || !note) return;
		// Captured before anything hides it: hovered Preview if on screen, else the dot.
		const sourceRect = panelGrowthSource(note);
		acknowledgeDot(note.id); // opening Acknowledges its dot (ADR-0010)
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
		// The playhead is stable now (opening paused it): it fixes both the panel
		// variant (a Spoiler's lock state) and whether Go here is near the moment.
		const playhead = video ? Number(video.currentTime) : Infinity;
		const variant = YTB.notePanelVariant(note, playhead);
		const panel = buildPanel(note, playhead, variant);
		host.appendChild(panel);
		// Hover-scope the Controls Hold: awake only while the pointer hovers the
		// panel, not for its whole lifetime or on auto-focus.
		panelHoldRelease = YTB.bindHoverHold(panel);
		positionPanel(panel);
		// The reply list seeded while detached (zero heights), so renderReplies'
		// bottom-pin couldn't engage; pin now to open on the newest reply (UA-008).
		const seededReplies = panel.querySelector('.ytb-panel-replies');
		if (seededReplies) seededReplies.scrollTop = seededReplies.scrollHeight;
		panel.focus();
		const anchorDot = dotFor(note.id);
		anchorDot?.classList.add(DOT_OPEN_CLASS); // hides its preview on the first FLIP frame
		// Pin the anchor's Cluster fanned while the panel is open.
		anchorDot?.closest('.' + CLUSTER_CLASS)?.classList.add(CLUSTER_PINNED_CLASS);
		flipPanelOpen(panel, sourceRect);

		// Only a text Note has a conversation to poll; read-only variants just
		// refresh their posted-time label.
		if (variant === 'text') startConversationPoll(panel);
		labelTimer = setInterval(() => refreshTimeLabels(panel), LABEL_REFRESH_MS);
	}

	// Build the Expanded Note per `variant` (YTB.notePanelVariant): 'text' gets
	// the full conversation (Replies, composer, author-only delete); 'reaction'
	// and 'spoiler' are read-only. Every variant pins the corner timestamp and
	// offers Go here unless the paused playhead already sits near the moment.
	function buildPanel(note, playhead, variant) {
		const who = note.clientId === myClientId ? 'You' : YTB.buddyName(note.clientId, note.name, roster);
		const panel = document.createElement('section');
		panel.id = PANEL_ID;
		panel.setAttribute('role', 'dialog');
		panel.setAttribute(
			'aria-label',
			variant === 'reaction' ? `Reaction by ${who}` : variant === 'spoiler' ? `Spoiler note by ${who}` : `Note by ${who}`,
		);
		panel.tabIndex = -1;

		const time = document.createElement('div');
		time.className = 'ytb-panel-time';
		time.textContent = '@' + YTB.formatTime(note.timestamp);
		panel.append(time);

		// Body area: emoji + author for a Reaction, masked placeholder for a
		// locked Spoiler, otherwise the text Note itself.
		if (variant === 'reaction') {
			const emoji = document.createElement('div');
			emoji.className = 'ytb-panel-emoji';
			emoji.textContent = note.body;
			const emojiAuthor = document.createElement('div');
			emojiAuthor.className = 'ytb-panel-emoji-author';
			emojiAuthor.textContent = who;
			if (note.clientId !== myClientId) {
				emojiAuthor.style.color = YTB.buddyTextColor(note.clientId);
				emojiAuthor.dataset.ytbColorCid = note.clientId; // live repaint hook (#115)
			}
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

		// Actions: Go here (omitted near the moment) plus the author-only delete
		// on a text Note; the row is appended only if non-empty.
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
		updateReplyArea(panel, note, replyCount(note.id));
		refreshConversation(panel);
		return panel;
	}

	// The Note's byline: posted-time always, author before it unless showAuthor
	// is false (a Reaction already names its author beneath the emoji).
	function buildByline(note, who, showAuthor) {
		const byline = document.createElement('div');
		byline.className = 'ytb-panel-byline';
		if (showAuthor) {
			const author = document.createElement('span');
			author.className = 'ytb-panel-author';
			author.textContent = who;
			if (note.clientId !== myClientId) {
				author.style.color = YTB.buddyTextColor(note.clientId);
				author.dataset.ytbColorCid = note.clientId; // live repaint hook (#115)
			}
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

	// Go here: the panel's one seek control (the aria-label speaks the moment).
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

	// Keep panel interactions inside the panel (no player seeks/toggles), and
	// let Escape dismiss it without reaching YouTube's hotkeys.
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

	// The author-only delete flow: a deemphasized "Delete" that swaps to an
	// in-panel confirmation naming the Replies that cascade with it.
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

	// Rebuild the Reply list (oldest to newest), keeping a bottom-pinned scroll;
	// new rows (not the initial render) settle in with a mild spring.
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
			if (reply.clientId !== myClientId) {
				author.style.color = YTB.buddyTextColor(reply.clientId);
				author.dataset.ytbColorCid = reply.clientId; // live repaint hook (#115)
			}
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

	// The bottom of the panel: Reply composer, or the Reply-cap state. Sharing
	// does not gate Reply writes (CONTEXT.md).
	function updateReplyArea(panel, note, count) {
		const area = panel.querySelector('.ytb-panel-reply-area');
		if (!area) return;
		const state = count >= YTB.MAX_REPLIES ? 'capped' : 'composer';
		if (area.dataset.ytbState === state) return;
		area.dataset.ytbState = state;
		area.replaceChildren();

		if (state === 'capped') {
			const message = document.createElement('p');
			message.className = 'ytb-panel-reply-note';
			message.textContent = 'Reply limit reached';
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
		// Attach the @-mention popover BEFORE our own ytb:keydown listener so an
		// open popover consumes Enter/Escape instead of posting/dismissing.
		const mentionCtl = window.YTBMentions ? YTBMentions.attach(textarea) : null;

		// Paper-plane send: springs in once the field is non-empty.
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
			// Success appends immediately without closing; the synthetic input
			// resizes the field and retracts the send button.
			textarea.value = '';
			mentionCtl?.reset();
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
			appendLocalReply(panel, note, result.reply);
			textarea.focus();
			return;
		}
		error.textContent = YTB.errorCopy(result.category, 'reply');
		if (result.category === 'reply_cap') {
			updateReplyArea(panel, note, YTB.MAX_REPLIES);
			refreshConversation(panel); // pull the replies we didn't know about
		} else if (result.category === 'missing_parent') {
			removeNoteEverywhere(note);
		} else {
			textarea.focus(); // draft intact - retry is one keypress away
		}
	}

	function appendLocalReply(panel, note, reply) {
		// Reconciled by server id: the next Room read/poll can't duplicate this record.
		const list = repliesFor(note.id);
		if (!list.some((existing) => existing.id === reply.id)) {
			repliesByNoteId.set(note.id, [...list, reply]);
		}
		renderReplies(panel, repliesFor(note.id));
		const wrap = panel.querySelector('.ytb-panel-replies');
		if (wrap) wrap.scrollTop = wrap.scrollHeight;
		if (replyCount(note.id) >= YTB.MAX_REPLIES) {
			updateReplyArea(panel, note, YTB.MAX_REPLIES);
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
			// Replies surfacing while the conversation is open are on screen
			// already: Acknowledge now so closing the panel never starts a pulse.
			recomputeUnseen();
			acknowledgeDot(note.id);
			renderReplies(panel, result.replies);
			if (openNote === note) updateReplyArea(panel, note, result.replies.length);
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

		// The resting anchor clears the lifted dot glyphs via panelBarClearance
		// (#173), so a lift change carries the panel with it.
		const bar = document.querySelector('.ytp-progress-bar');
		const barRect = bar ? bar.getBoundingClientRect() : null;
		const bottom = barRect ? Math.max(12, hostRect.bottom - barRect.top + YTB.panelBarClearance(BAND)) : 72;
		panel.style.bottom = Math.min(bottom, Math.max(12, hostRect.height - 40)) + 'px';

		const dot = openNote && dotFor(openNote.id);
		const dotRect = dot ? dot.getBoundingClientRect() : null;
		const center = dotRect ? dotRect.left + dotRect.width / 2 - hostRect.left : hostRect.width / 2;
		const left = Math.max(8, Math.min(center - width / 2, hostRect.width - width - 8));
		panel.style.left = left + 'px';

		// Never taller than the player: the Reply list absorbs the squeeze, its
		// fixed chrome measured live so growth re-clamps instead of pushing past
		// the player's top. If even the minimum list can't fit, the panel slides
		// down over the control bar rather than out of the player.
		const replies = panel.querySelector('.ytb-panel-replies');
		if (replies) {
			const chrome = panel.offsetHeight - replies.offsetHeight;
			let anchor = parseFloat(panel.style.bottom);

			// Margin from the panel's ceiling: normally 16px below the player top,
			// but capped just below YouTube's storyboard thumbnail when it floats
			// above the scrubber (skipped if that would leave no usable panel).
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
		panelHoldRelease?.(); // hand the autohide timer back to YouTube
		panelHoldRelease = null;
		panelPressOrigin = 'elsewhere';
		document.getElementById(PANEL_ID)?.remove();
		document.querySelector('.' + DOT_OPEN_CLASS)?.classList.remove(DOT_OPEN_CLASS);
		document.querySelector('.' + CLUSTER_PINNED_CLASS)?.classList.remove(CLUSTER_PINNED_CLASS);
		openNote = null;
		pendingReply = false;
		pendingDelete = false;
	}

	// Dismiss the Expanded Note. If opening it paused a playing video, dismissal
	// resumes it; keyboard dismissal refocuses the origin dot.
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

	// Capture where the gesture began, before containment stops the pointerdown:
	// a selection dragged past the panel edge still reports as panel-owned.
	document.addEventListener(
		'pointerdown',
		(event) => {
			const panelOpen = Boolean(document.getElementById(PANEL_ID));
			if (!panelOpen) {
				panelPressOrigin = 'elsewhere';
				return;
			}
			const path = event.composedPath ? event.composedPath() : [event.target];
			panelPressOrigin = path.some((target) => target instanceof Element && target.id === PANEL_ID) ? 'overlay' : 'elsewhere';
		},
		true,
	);

	// Route every click while the Expanded Note is open (capture phase);
	// YTB.pictureClickAction owns the decision shared with composer.js.
	document.addEventListener(
		'click',
		(event) => {
			const pressOrigin = panelPressOrigin;
			panelPressOrigin = 'elsewhere';
			const panelOpen = Boolean(document.getElementById(PANEL_ID));
			if (!panelOpen) return;
			const path = event.composedPath ? event.composedPath() : [];
			for (const target of path) {
				if (!(target instanceof Element)) continue;
				// A click on the Cluster wrapper's hover-keeper (a gap between
				// fanned dots) is interacting with the Cluster, not dismissing.
				if (
					target.id === PANEL_ID ||
					target.classList.contains(DOT_CLASS) ||
					target.classList.contains(CLUSTER_CLASS) ||
					target.classList.contains('ytb-alert-card')
				)
					return;
			}

			const route = YTB.pictureClickAction({
				overlayOpen: panelOpen,
				region: YTB.pictureClickRegion(event.target),
				pressOrigin,
				pauseHold: pauseLease,
				withinGrace: YTB.withinArrivalGrace(),
			});
			if (route.consume) {
				event.preventDefault();
				event.stopPropagation();
			}
			if (!route.close) return;
			if (route.cancelArrivalGrace) YTB.cancelArrivalGrace();
			dismissPanel({ resume: false });
			if (route.play) document.querySelector('video')?.play();
		},
		true,
	);

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && document.getElementById(PANEL_ID)) {
			dismissPanel({ refocusDot: true });
		}
	});

	// A play during the arrival grace is autoplay settling in; re-assert the
	// pause so the Unseen dot stays in view. Otherwise it's a deliberate resume,
	// which dismisses an open Expanded Note (without re-pausing).
	document.addEventListener(
		'play',
		(event) => {
			if (!(event.target instanceof HTMLVideoElement)) return;
			const action = YTB.playAction({
				withinGrace: YTB.withinArrivalGrace(),
				panelOpen: Boolean(document.getElementById(PANEL_ID)),
			});
			if (action === 'ignore') return;
			if (action === 'hold') {
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
		// A stale script must not keep feeding the player's autohide timer.
		for (const wrapper of [...holdBySurface.keys()]) releaseControlsHolds(wrapper);
	});

	// -------------------------------------------------------------------------
	// Playback Notification triggers (rendering lives in notes-alerts.js).
	// -------------------------------------------------------------------------

	// Natural forward crossings only: every ordinary playback crossing triggers
	// (including replays after rewinding); seeks rebase silently, and so does a
	// Post Echo, which fires its own Note's notification up front.
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
			// Queue the entrance but Acknowledge NOW: the crossing itself is the
			// ADR-0010 trigger, not the staggered reveal.
			alerts.enqueue(note, 'crossing');
			acknowledgeDot(note.id);
		}
	}

	// -------------------------------------------------------------------------
	// Wiring: pure consumer of content.js events; registered synchronously.
	// -------------------------------------------------------------------------

	document.addEventListener('ytb:navigate', (event) => {
		const nextVideoId = (event.detail && event.detail.videoId) || null;
		// YouTube re-emits a navigation-finish for the SAME video while the watch
		// page loads; treat as a no-op (tearing down would dismiss the panel and
		// let autoplay escape the arrival grace) - only reconcile dots.
		if (nextVideoId === currentVideoId) {
			renderDots();
			return;
		}
		currentVideoId = nextVideoId;
		lastPlaybackTime = null;
		YTB.cancelArrivalGrace();
		dismissPanel({ resume: false });
		pauseLease = false;
		alerts.reset();
		renderDots();
	});

	document.addEventListener('ytb:mutation', () => {
		renderDots();
		const panel = document.getElementById(PANEL_ID);
		if (panel) positionPanel(panel);
	});

	for (const type of ['resize', 'fullscreenchange']) {
		window.addEventListener(type, () => {
			renderDots(); // re-form Clusters + reposition dots at the new bar width
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
})();
