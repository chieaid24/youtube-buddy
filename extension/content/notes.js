// extension/notes.js
//
// ALL Note/Reaction presentation on the watch page: Video Timeline dots,
// hover Note Previews, the Expanded Note panel (text/Reaction/locked-Spoiler
// variants), Playback Notifications (natural crossing + Post Echo triggers),
// and Unseen pulses (ADR-0010) - see CONTEXT.md for the full behavior spec.
// Renders and Acknowledges nothing while Notes Visibility is off.
//
// Styling consumes the --ytb-* tokens theme.js injects; theme.js also
// isolates Reply-textarea keystrokes from YouTube's hotkeys, re-dispatched
// as `ytb:keydown` (listened for below).
//
// Pure consumer per ADR-0001: content.js owns navigation/mutation events,
// renderer.js owns Room polling (rebroadcast here as `ytb:room-data`);
// composer.js hands freshly posted records via `ytb:note-posted` so the
// Video Timeline reconciles immediately without waiting for a poll.

(function () {
	'use strict';

	const DOT_CLASS = 'ytb-note-dot';
	const DOT_TEXT_CLASS = 'ytb-note-dot-text';
	const DOT_REACTION_CLASS = 'ytb-note-dot-reaction';
	const DOT_LOCKED_CLASS = 'ytb-note-dot-locked';
	const DOT_OPEN_CLASS = 'ytb-note-dot-open'; // suppresses the open Note's own preview
	const DOT_UNSEEN_CLASS = 'ytb-note-dot-unseen'; // pulses the apricot halo (ADR-0010)
	const DOT_PASSED_CLASS = 'ytb-note-dot-passed'; // dims a Note after the playhead crosses it
	const CLUSTER_CLASS = 'ytb-dot-cluster'; // wrapper owning a Cluster's hover/fan (#123)
	const CLUSTER_PINNED_CLASS = 'ytb-dot-cluster-pinned'; // stays fanned while its Note's panel is open
	const TOOLTIP_SUPPRESSED_CLASS = 'ytb-note-tooltip-suppressed'; // hides YouTube's stale storyboard while a Cluster is hovered
	// Note Band geometry (#173) lives in shared.js so dotHitReaches/panelBarClearance
	// derive from the same numbers this file styles with.
	const BAND = YTB.NOTE_BAND;
	const DOT_DIAMETER = BAND.dotDiameter; // px - matches the .ytb-note-dot circle; drives clustering + clamp
	const LAYOUT_UNITS_PER_PX = 64; // Chromium's subpixel layout grid
	const CLUSTER_FAN_GAP = 14; // px - the Fan Gap's IDEAL; it shrinks toward DOT_DIAMETER on a crowded bar
	const UNSEEN_RING_GAP = '#0f0f0f'; // separates the reduced-motion Unseen ring from the Buddy-colored fill (UA-026)
	const PREVIEW_CLASS = 'ytb-note-preview';
	const PANEL_ID = 'ytb-note-panel';
	const ALERTS_ID = 'ytb-note-alerts';
	const STYLE_ID = 'ytb-notes-style';

	const CONVERSATION_POLL_MS = 5000; // focused Expanded Note freshness
	const LABEL_REFRESH_MS = 30_000; // "Posted 8 min ago" recomputation
	// Concurrent crossings enter one-per-beat on this stagger, in timestamp order,
	// instead of all at once (each notification's own lifetime still starts at
	// its own entrance); lifetimes themselves come from YTB.notificationLifetime.
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
	// Crossed Notes drain one-per-beat (ENTRANCE_STAGGER_MS); timer is non-null
	// exactly while a drain is in flight.
	let alertQueue = [];
	let alertDrainTimer = null;
	// Unseen state (ADR-0010): seenSet mirrors the Room's persisted seen list
	// (loaded/pruned each Room read); unseenDotIds is the derived pulse set, kept
	// synchronous so renderDots (runs every timeupdate) never awaits storage.
	let seenSet = new Set();
	let unseenDotIds = new Set();

	// Expanded Note state. pauseLease: true iff OPENING (the first panel in a
	// chain of replacements) paused a playing video, so dismissal knows to resume.
	let openNote = null;
	let pauseLease = false;
	let panelPressOrigin = 'elsewhere'; // capture-time origin for the next click (ADR-0011)
	let pollTimer = null;
	let labelTimer = null;
	let pendingReply = false;
	let pendingDelete = false;
	// A Room Feed row (home-section.js) may record a video to pause on arrival
	// (ADR-0010), consumed on that video's first Room read iff an Unseen dot is
	// on it. Loaded once (full reload) and mirrored live from storage (SPA nav).
	let pendingArrival = null;
	// Settings (live via chrome.storage.onChanged below).
	let notesHidden = false; // Notes Visibility off: zero Note UI on the player
	let notificationPosition = 'bottom'; // Playback Notification edge

	// Controls Hold state (CONTEXT.md): dots swallow the pointer events that would
	// keep YouTube's chrome awake, so YTB.controlsHold re-feeds its timer instead
	// while a Note surface is engaged. Holds are keyed by Cluster wrapper;
	// sweepControlsHolds releases any wrapper that left the DOM without firing
	// mouseleave/focusout, so a hold can never leak.
	const holdBySurface = new Map(); // wrapper Element -> { hover: release|null, focus: release|null }
	let panelHoldRelease = null; // teardown for the Expanded Note's hover-scoped hold

	injectStyle();

	YTB.getSettings().then((settings) => {
		notesHidden = settings.notesHidden;
		notificationPosition = settings.notificationPosition;
		renderDots();
	});

	// Read any arrival a Room Feed row left before this script (re)loaded; the
	// decision runs once that video's Room read lands. SPA nav never reloads
	// this script, so the onChanged mirror below picks up the write instead.
	YTB.getPendingArrival().then((arrival) => {
		pendingArrival = arrival;
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
		if ('pendingArrival' in changes) {
			const next = changes.pendingArrival.newValue;
			// Mirror only; the decision waits for this video's Room read (below).
			pendingArrival = next && next.videoId ? next : null;
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
	});

	// ---------------------------------------------------------------------------
	// Unseen state (ADR-0010): the pulse set and the three Acknowledge triggers.
	// ---------------------------------------------------------------------------

	/** The Room read shape the pure Unseen helpers take, rebuilt from the maps so
	 * local appends reflect immediately without waiting for the next Room poll. */
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

	// Reload (and prune) the seen set after a Room read, then derive the pulse
	// set. Pruning only follows a SUCCESSFUL read, since a failed GET's empty
	// arrays would otherwise resurrect every Acknowledged pulse.
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

	// Acknowledge one Note Dot: clears every Unseen item anchored to it (the
	// Mention and all Unseen Replies) at once and stops its pulse for good.
	function acknowledgeDot(noteId) {
		if (notesHidden || !noteId || !unseenDotIds.has(noteId)) return;
		const ids = YTB.acknowledgeTargets(currentRecords(), myClientId, noteId);
		if (ids.length === 0) return;
		for (const id of ids) seenSet.add(id);
		unseenDotIds.delete(noteId);
		YTB.markSeen(activeRoomCode, ids); // best-effort persist; the in-memory set already stopped the pulse
		renderDots();
	}

	/** Does the current video carry an Unseen dot? unseenDotIds is Room-wide, so
	 * this scopes it to the current video's notes before the arrival-pause decision. */
	function hasUnseenDotOnCurrentVideo() {
		for (const note of notesForCurrentVideo()) {
			if (unseenDotIds.has(note.id)) return true;
		}
		return false;
	}

	// A Room Feed row asked to pause on arrival IF something is Unseen (ADR-0010).
	// On the target video, consume the one-shot handshake now regardless of the
	// outcome (so it never refires on a later visit), then pause only when Notes
	// are visible AND a dot on this video is Unseen. A stale or other-video
	// handshake is left/dropped until it expires.
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
		// Pause at the viewer's own place and hold through the watch page's autoplay
		// settling (reusing the load-churn grace); the Unseen dot(s) pulse, and the
		// viewer chooses which to open.
		YTB.startArrivalGrace();
		if (!video.paused) video.pause();
	}

	function clearPendingArrival() {
		pendingArrival = null;
		YTB.clearPendingArrival();
	}

	// Buddy Color re-assignment (issue #115): renderDots repaints dots + Previews;
	// the open Expanded Note is separate DOM renderDots never touches, so restyle
	// its stamped author spans in place (keeps scroll position and pause lease).
	document.addEventListener('ytb:buddy-colors', () => {
		renderDots();
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		for (const span of panel.querySelectorAll('[data-ytb-color-cid]')) {
			span.style.color = YTB.buddyTextColor(span.dataset.ytbColorCid);
		}
	});

	// composer.js posted a Note/Reaction: insert the record into the Video
	// Timeline immediately (no waiting for the 60s Room poll), then fire its Post Echo.
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
	// post - the second trigger alongside a natural forward crossing, and
	// independent of playback. Rebases the crossing window past the Note's own
	// timestamp so the composer's lease-aware resume can't replay it.
	function postEcho(note) {
		// Notes off renders nothing, the echo included (composer.js already
		// removed the + button, so this is a guard, not a live path).
		if (notesHidden || note.videoId !== currentVideoId) return;
		const timestamp = Number(note.timestamp);
		if (Number.isFinite(timestamp)) {
			lastPlaybackTime = lastPlaybackTime === null ? timestamp : Math.max(lastPlaybackTime, timestamp);
		}
		alertQueue.push({ note, trigger: 'echo' });
		scheduleAlertDrain();
	}

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
		sweepControlsHolds(); // a wrapper YouTube detached must not hold the chrome awake
		const bar = document.querySelector('.ytp-progress-bar');
		const video = document.querySelector('video');
		if (!bar) return; // player not built yet - a later ytb:mutation retries

		const duration = video ? Number(video.duration) : NaN;
		const playhead = video ? Number(video.currentTime) : 0;
		const desired = new Map(); // id -> { note, locked, passed, timestamp }
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
					passed: playhead >= timestamp,
					timestamp,
				});
			}
		}

		// Index every existing dot by id - a dot lives under a Cluster wrapper now,
		// so search the whole bar, not just its direct children.
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
		// re-measured every render so late chapters/resize/fullscreen re-align them.
		// Never displaced at rest: co-timed dots overlap, fanning apart only on hover.
		const ids = [...desired.keys()];
		const barWidth = bar.getBoundingClientRect().width || 0;
		const segments = YTB.barSegments(bar);
		const px = ids.map(
			(id) => Math.round(YTB.timeToX(segments, desired.get(id).timestamp, duration) * LAYOUT_UNITS_PER_PX) / LAYOUT_UNITS_PER_PX,
		);

		// Solve the fan for the WHOLE bar in one go (#162): every dot stays as close
		// to its true moment as the Fan Gap allows, so a fanned dot can never reach
		// one at rest elsewhere. Recomputed every render as the bar resizes.
		const { clusters, offsets } = YTB.solveDotFan(px, {
			idealGap: CLUSTER_FAN_GAP,
			barWidth,
			dotDiameter: DOT_DIAMETER,
		});

		const hitReaches = YTB.dotHitReaches(px, BAND.dotDiameter, BAND.hitMaxSideReach);

		// Reconcile Cluster wrappers keyed by exact membership: a steady poll reuses
		// each wrapper (re-parenting a dot would restart its Unseen pulse), and only
		// a Note added/removed rebuilds the affected wrapper.
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
				// Swallow press/hover over the keeper (the fan's gaps) like the dots do,
				// so YouTube pops no storyboard/time pill behind the fan; harmless at
				// rest since the wrapper is pointer-events:none there.
				for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mousemove', 'mouseover']) {
					wrapper.addEventListener(type, (e) => e.stopPropagation());
				}
				// Hide any storyboard tooltip YouTube already showed crossing the
				// scrubber en route, for the whole fanned hover band; restore on leave.
				wrapper.addEventListener('mouseenter', () => setStoryboardSuppressed(wrapper, true));
				wrapper.addEventListener('mouseleave', () => setStoryboardSuppressed(wrapper, false));
				// Hover/keyboard focus anywhere in the wrapper (dots + Previews) takes a
				// Controls Hold, feeding the swallowed pointer activity back to the player.
				bindControlsHold(wrapper);
				bar.appendChild(wrapper);
			}
			// Anchors at the Cluster centre in bar px (chapter geometry has no fixed
			// percentage to lean on); members sit at their true px offset from that
			// centre, with the fan as a hover-only transform on top.
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
			// gaps the fan opens (and travel between members) without collapsing it.
			wrapper.style.setProperty('--ytb-fan-extent', (2 * (halfExtent + DOT_DIAMETER / 2)).toFixed(2) + 'px');
			// A Cluster with an open Expanded Note stays fanned, so the anchor dot
			// never slides out from under the panel.
			wrapper.classList.toggle(CLUSTER_PINNED_CLASS, Boolean(openNote) && memberIds.includes(openNote.id));
		}

		// Drop wrappers whose membership no longer exists; their surviving dots were
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
	// focusin/out bubble from the whole subtree (dots + Previews), so this one
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

	// Release holds of wrappers that left the DOM without firing mouseleave/
	// focusout (YouTube rebuilt the bar, or navigation dropped it). Runs every
	// renderDots pass, so a leaked hold lives one render at most.
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
		// Never let the player interpret a dot press as a seek; clicking the dot or
		// its Preview opens the Expanded Note (Go here is the only seek). The hover
		// family is swallowed too, so YouTube pops no storyboard/time pill behind it.
		for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mousemove', 'mouseover']) {
			dot.addEventListener(type, (e) => e.stopPropagation());
		}
		dot.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			onDotActivate(dot);
		});
		// Hover and keyboard focus both Acknowledge the dot (ADR-0010) and unfold
		// its Preview, so each also clamps it inside the player first (#181).
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

	/**
	 * Slide a Note Preview back inside the player's edges before it unfolds (#181):
	 * a Preview centred near the bar's ends would overflow and clip. Measures the
	 * card's layout width against the player box and sets --ytb-preview-shift only
	 * when it would spill past positionPanel's 8px inset; the paired transform-origin
	 * and ::before bridge read the same variable so a shifted card still grows out
	 * of its dot. Shift is 0 whenever the card already fits.
	 */
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
		// Unseen dots pulse until Acknowledged (ADR-0010); box-shadow only, so
		// neighbouring (possibly overlapping) dots are never displaced.
		const unseen = unseenDotIds.has(id);
		dot.classList.toggle(DOT_UNSEEN_CLASS, unseen);
		// The Unseen eye-catch outranks the passed paint until Acknowledged.
		dot.classList.toggle(DOT_PASSED_CLASS, passed && !unseen);

		const count = replyCount(id);
		// The resolved paint color is part of the signature: a Buddy Color
		// re-assignment (issue #115) must rebuild the retained dot's Note Preview,
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

	// Activating any Note Dot/Preview opens its Expanded Note without seeking
	// (Go here is the only seek); YTB.dotActivation owns the routing.
	function onDotActivate(dot) {
		const note = findNote(dot.dataset.ytbNoteId);
		if (!note) return;
		if (YTB.dotActivation(note).action === 'open') openPanel(note);
	}

	// Go here: seek just before the Note and resume, so it reveals via its own
	// Playback Notification on the natural crossing. Local-only; works regardless
	// of Sharing.
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
		// Text Note: body is the hero, author beneath, Reply count last. A locked
		// Spoiler keeps this layout with the body masked and count withheld.
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

	// ---------------------------------------------------------------------------
	// Expanded Note: the pinned conversation panel.
	// ---------------------------------------------------------------------------

	function player() {
		return document.querySelector('#movie_player');
	}

	function dotFor(noteId) {
		const bar = document.querySelector('.ytp-progress-bar');
		if (!bar) return null;
		// Dots nest inside their Cluster wrapper, so search the whole bar.
		for (const dot of bar.querySelectorAll('.' + DOT_CLASS)) {
			if (dot.dataset.ytbNoteId === noteId) return dot;
		}
		return null;
	}

	// The rectangle the Expanded Note grows out of: the hovered Preview card if
	// one is on screen, else the dot itself. Null when there is no dot to grow from.
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

	// Grow the already-positioned panel out of `sourceRect` with a FLIP: invert
	// onto the source rect and play back to identity (the Web Animations API
	// auto-clears the transform, leaving nothing for positionPanel to re-clamp).
	// prefers-reduced-motion collapses to an opacity fade; no source falls back
	// to a small scale-up.
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

	/**
	 * Open (or replace) the Expanded Note for `note`. Never seeks: it pauses at
	 * the viewer's current position. Only the FIRST open of a chain acquires the
	 * pause lease; replacing one panel with another keeps the video paused and
	 * the original lease.
	 */
	async function openPanel(note) {
		const host = player();
		if (!host || !note) return;
		// Where the Expanded Note grows FROM - captured before anything hides it:
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
		// The playhead is stable now (opening paused it): it fixes both the panel
		// variant (a Spoiler's lock state) and whether Go here is near the moment.
		const playhead = video ? Number(video.currentTime) : Infinity;
		const variant = YTB.notePanelVariant(note, playhead);
		const panel = buildPanel(note, playhead, variant);
		host.appendChild(panel);
		// Hover-scope the Controls Hold: keeps the chrome awake only while the
		// pointer hovers the panel, not for its whole lifetime or on auto-focus.
		panelHoldRelease = YTB.bindHoverHold(panel);
		positionPanel(panel);
		// The reply list seeded while detached (zero heights), so renderReplies'
		// bottom-pin couldn't engage; pin now to open on the newest reply (UA-008).
		const seededReplies = panel.querySelector('.ytb-panel-replies');
		if (seededReplies) seededReplies.scrollTop = seededReplies.scrollHeight;
		panel.focus();
		const anchorDot = dotFor(note.id);
		anchorDot?.classList.add(DOT_OPEN_CLASS); // hides its preview on the first FLIP frame
		// Pin the anchor's Cluster fanned for as long as the panel is open, so the
		// dot does not slide out from under it.
		anchorDot?.closest('.' + CLUSTER_CLASS)?.classList.add(CLUSTER_PINNED_CLASS);
		flipPanelOpen(panel, sourceRect); // grow the panel out of that source rect

		// Only a text Note has a conversation to poll; read-only variants (Reaction,
		// locked Spoiler) just refresh their posted-time label.
		if (variant === 'text') startConversationPoll(panel);
		labelTimer = setInterval(() => refreshTimeLabels(panel), LABEL_REFRESH_MS);
	}

	/**
	 * Build the Expanded Note in the shape `variant` demands (from
	 * YTB.notePanelVariant): 'text' gets the full conversation (Replies,
	 * composer, author-only delete); 'reaction' and 'spoiler' are read-only.
	 * Every variant pins the corner timestamp and offers Go here unless the
	 * paused playhead already sits near the moment.
	 */
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

		// The Note's video timestamp, pinned in the top-right corner (matching the
		// Note Preview's corner timestamp), on every variant.
		const time = document.createElement('div');
		time.className = 'ytb-panel-time';
		time.textContent = '@' + YTB.formatTime(note.timestamp);
		panel.append(time);

		// Body area: emoji + author for a Reaction, masked placeholder for a locked
		// Spoiler, otherwise the text Note itself; author sits in the byline except
		// for a Reaction, where it's beneath the emoji.
		if (variant === 'reaction') {
			const emoji = document.createElement('div');
			emoji.className = 'ytb-panel-emoji';
			emoji.textContent = note.body;
			const emojiAuthor = document.createElement('div');
			emojiAuthor.className = 'ytb-panel-emoji-author';
			emojiAuthor.textContent = who;
			if (note.clientId !== myClientId) {
				emojiAuthor.style.color = YTB.buddyTextColor(note.clientId);
				emojiAuthor.dataset.ytbColorCid = note.clientId; // live repaint hook (issue #115)
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

		// Note actions: Go here (omitted when already near the moment) plus the
		// author-only delete on a text Note; the row is appended only if non-empty.
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
				author.dataset.ytbColorCid = note.clientId; // live repaint hook (issue #115)
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

	// Go here: the panel's one seek control (labelled plainly; the aria-label
	// speaks the moment).
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

	// Rebuild the Reply list (oldest to newest), keeping a bottom-pinned scroll.
	// New rows (not the initial render) settle in with a mild spring.
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
				author.dataset.ytbColorCid = reply.clientId; // live repaint hook (issue #115)
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

	/** The bottom of the panel: Reply composer, or the Reply-cap state. */
	function updateReplyArea(panel, note, count) {
		const area = panel.querySelector('.ytb-panel-reply-area');
		if (!area) return;
		// Sharing does not gate Reply writes (CONTEXT.md); the Reply composer only
		// exists inside a Room, so the sole non-composer state is the 10-Reply cap.
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
			// Success appends immediately, oldest to newest, without closing. The
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
			updateReplyArea(panel, note, YTB.MAX_REPLIES);
			refreshConversation(panel); // pull the replies we didn't know about
		} else if (result.category === 'missing_parent') {
			removeNoteEverywhere(note);
		} else {
			textarea.focus(); // draft intact - retry is one keypress away
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
			// Replies surfacing while the conversation is open are on screen already:
			// Acknowledge now so closing the panel never starts a pulse for it.
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
		// (#173), derived from Note Band geometry so a lift change carries the panel with it.
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

			// Margin from the panel's own ceiling: normally 16px below the player
			// top, but capped just below YouTube's storyboard thumbnail when it
			// floats above the scrubber (skipped if that would leave no usable
			// panel; the panel's own z-index keeps it above the thumbnail there).
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

	// Route every click while the Expanded Note is open (capture phase). Press
	// Origin protects a dragged-out selection; YTB.pictureClickAction owns the
	// shared decision with composer.js.
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
				// A click on the Cluster wrapper's hover-keeper (a gap between fanned
				// dots) is interacting with the Cluster, not dismissing the panel.
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
	 * Anchor the alerts stack at the viewer's Notification Position and lay its
	 * children along that edge: top/bottom is a centered row that wraps away
	 * from the edge, left/right a column. Inline styles own placement/axis so a
	 * Settings change re-anchors live; the stylesheet carries only the static look.
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

	function showNoteCard(note, trigger) {
		const wrap = alertsContainer();
		if (!wrap) return;
		const lifetime = YTB.notificationLifetime(note.kind, trigger);
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
		if (note.clientId !== myClientId) author.style.color = YTB.buddyTextColor(note.clientId);
		// Author beneath the content, matching the Note Preview (no timestamp here -
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
		}, lifetime);
	}

	function showReactionBurst(note, trigger) {
		const wrap = alertsContainer();
		if (!wrap) return;
		const lifetime = YTB.notificationLifetime(note.kind, trigger);
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
		// Keyframes are percentage-based, so a per-element duration scales the whole
		// float-and-fade (a short echo compresses, never truncates mid-flight).
		burst.style.animationDuration = `${lifetime}ms`;
		wrap.append(burst);
		setTimeout(() => burst.remove(), lifetime);
	}

	// Natural forward crossings only: every ordinary playback crossing triggers
	// (including replays after rewinding); seeks rebase silently below, and so
	// does a Post Echo, which fires its own Note's notification up front.
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
			// staggered reveal - a no-op unless the dot was Unseen.
			alertQueue.push({ note, trigger: 'crossing' });
			acknowledgeDot(note.id);
		}
		scheduleAlertDrain();
	}

	// Reveal one queued Note per ENTRANCE_STAGGER_MS beat, in the order queued
	// (crossedNotes is timestamp-sorted). Earlier notifications stay on screen as
	// later ones arrive - each lives its own lifetime from its own entrance.
	function scheduleAlertDrain() {
		if (alertDrainTimer !== null || alertQueue.length === 0) return;
		drainNextAlert();
	}

	function drainNextAlert() {
		const entry = alertQueue.shift();
		if (!entry) {
			alertDrainTimer = null;
			return;
		}
		const { note, trigger } = entry;
		if (note.kind === 'emoji') showReactionBurst(note, trigger);
		else showNoteCard(note, trigger);
		alertDrainTimer = setTimeout(drainNextAlert, ENTRANCE_STAGGER_MS);
	}

	// Drop every on-screen and queued notification and cancel the drain - for a
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
		// YouTube re-emits a navigation-finish for the SAME video while the watch
		// page loads; treat as a no-op (tearing down here would dismiss the panel
		// and clearing the arrival grace would let autoplay escape it) - only reconcile dots.
		if (nextVideoId === currentVideoId) {
			renderDots();
			return;
		}
		currentVideoId = nextVideoId;
		lastPlaybackTime = null;
		YTB.cancelArrivalGrace();
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

	/** Inject the notes stylesheet once. */
	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* Dot Cluster (#123): wrapper owning hover/focus for dots that overlap at
         rest. Carries the vertical lift and anchors at the Cluster centre in bar
         px, re-measured every render (#159); pointer-events:none at rest (only
         member dots catch the pointer), but a hovered ::before keeper spans the
         fanned band so travel between members doesn't collapse it.

         Every interactive surface we own lives STRICTLY ABOVE the progress bar's
         top edge (#158), so the bar stays seekable under a Note, timestamp
         included - the wrapper's bottom edge is that boundary.

         Inside the Note Band we outrank YouTube's own affordances (#173): measured
         stacking puts .ytp-progress-bar-padding at 28, .ytp-chapters-container at
         32, .ytp-timed-markers-container at 40, .ytp-scrubber-container at 43 - so
         our 44 wins honestly, by stacking order. The knob's pointer events stay
         untouched (needed for drag-scrub) and it remains fully grabbable on the
         bar itself; only its overlap INTO the band is conceded. */
      .${CLUSTER_CLASS} {
        position: absolute;
        bottom: calc(100% + ${BAND.dotLift}px);
        width: 0;
        height: ${DOT_DIAMETER}px;
        z-index: 44;
        pointer-events: none;
      }
      /* Hover keeper: reaches from above the dots down to FLUSH with the bar's top
         edge - the furthest it can go while claiming none of the bar (#158). No
         dead strip between bar and dots means travelling into a fan never crosses
         a gap that would collapse it (#162), and a press on the bar still seeks. */
      .${CLUSTER_CLASS}::before {
        content: '';
        position: absolute;
        left: 0;
        transform: translateX(-50%);
        width: var(--ytb-fan-extent, 0px);
        top: -4px;
        bottom: -${BAND.dotLift}px;
        pointer-events: none;
      }
      .${CLUSTER_CLASS}:hover::before { pointer-events: auto; }
      /* Fan members apart on hover, focus, or a pinned member's open panel. A
         transform only - base left offset never changes, and reverses instantly. */
      .${CLUSTER_CLASS}:hover > .${DOT_CLASS},
      .${CLUSTER_CLASS}:focus-within > .${DOT_CLASS},
      .${CLUSTER_CLASS}.${CLUSTER_PINNED_CLASS} > .${DOT_CLASS} {
        transform: translateX(var(--ytb-fan, 0px));
      }

      /* A flat, single-color circle just clear of the bar's top edge (nested in
         its Cluster wrapper, so it inherits autohide fade and stays bar-aligned
         through resizes/fullscreen for free). No border/outline/ring/shadow - a
         pale dot over a bright frame is the accepted trade. */
      .${DOT_CLASS} {
        position: absolute;
        bottom: 0;
        width: ${DOT_DIAMETER}px;
        height: ${DOT_DIAMETER}px;
        margin-left: ${-DOT_DIAMETER / 2}px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: #fff;
        cursor: default;
        /* pointer-events is inherited: the dot must re-assert auto so it stays
           hittable inside the pointer-events:none Cluster wrapper. */
        pointer-events: auto;
        transform: translateX(0);
        transition: transform var(--ytb-dur-base) var(--ytb-ease-spring);
      }
      /* Invisible hit extender (UA-004, resized by #202): each side stops at its
         nearest-neighbour midpoint, capped at the Note Band's max side reach.
         Grows UPWARD off the dot's bottom edge (#158) rather than centring on
         the glyph - a centred box hung into the bar stole every press near a
         Note's timestamp; bottom-anchored, it claims only the band above the
         bar (YouTube's grab pad included), never the bar itself. */
      .${DOT_CLASS}::after {
        content: '';
        position: absolute;
        left: calc(-1 * var(--ytb-hit-left, 0px));
        right: calc(-1 * var(--ytb-hit-right, 0px));
        bottom: 0;
        height: var(--ytb-hit-height, 0px);
      }
      .${DOT_TEXT_CLASS} { cursor: pointer; }
      .${DOT_CLASS}:focus-visible {
        outline: 2px solid var(--ytb-accent-500);
        outline-offset: 1px;
      }
      .${DOT_PASSED_CLASS} { filter: saturate(.4) opacity(.55); }

      /* Crossing the scrubber to reach a Note can leave YouTube's storyboard
         frozen over the Preview; toggled on the player root for the hover band. */
      .${TOOLTIP_SUPPRESSED_CLASS} .ytp-tooltip { display: none !important; }
      /* Locked Spoilers use a veil overlay, not filter/opacity on the dot itself,
         since that would also gray out or fade the Unseen halo and hover preview
         rendered on this same element (the preview paints above via its own z-index). */
      .${DOT_LOCKED_CLASS} { cursor: pointer; }
      .${DOT_REACTION_CLASS} { cursor: pointer; }   /* opens its panel like every dot (UA-025) */
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

      /* Unseen pulse (ADR-0010): expanding apricot halo, box-shadow only, so
         neighbouring dots are never displaced. Shares the popup Waiting dot's
         ~1.6s breathing rhythm (DESIGN.md section 2). */
      .${DOT_UNSEEN_CLASS} {
        animation: ytb-unseen-pulse 1.6s var(--ytb-ease-out) infinite;
      }
      @keyframes ytb-unseen-pulse {
        from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ytb-accent-500) 75%, transparent); }
        to   { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ytb-accent-500) 0%, transparent); }
      }
      /* An open panel's own hover preview hides INSTANTLY (no fade), vanishing on
         the first frame of the Expanded Note that grows out of it. */
      .${DOT_OPEN_CLASS} .${PREVIEW_CLASS} {
        opacity: 0 !important;
        transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px))) scale(0.6) !important;
        transition: none !important;
        pointer-events: none !important;
      }

      /* Note Preview: opaque warm card. Unfolds OUT OF the dot on hover -
         transform-origin sits 15px below the card's bottom edge (the 18px bottom
         gap less the dot's 3px half-height) so it grows from the dot rather than
         fading in from its own centre. Pure CSS; reduced-motion below collapses
         it to an opacity-only fade. */
      .${PREVIEW_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        /* --ytb-preview-shift (JS, clampPreview) slides a card back inside the
           player's edges near the bar's ends (#181); 0 mid-bar. The origin
           subtracts the same shift so the unfold still grows out of the dot,
           not the card's own displaced centre. */
        transform-origin: calc(50% - var(--ytb-preview-shift, 0px)) calc(100% + 15px);
        transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px))) scale(0.6);
        /* Two auto columns - content, then the corner timestamp (#158). The
           timestamp is a real grid item (not an absolute overlay), so it
           contributes intrinsic width: a max-content card always widens to fit
           body + time, with no hardcoded gutter. Past the 240px cap, the nowrap
           time column stays fixed and the body wraps/line-clamps instead. */
        display: grid;
        grid-template-columns: auto auto;
        column-gap: 10px;
        width: max-content;
        max-width: 240px;
        padding: 8px 12px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        box-shadow: var(--ytb-e-pop);
        font: 13px/1.4 var(--ytb-font);
        text-align: left;
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--ytb-dur-quick) var(--ytb-ease-out), transform var(--ytb-dur-quick) var(--ytb-ease-spring);
        z-index: 60;
      }
      /* Transparent hover bridge: a dot-width column bridging the gap so the
         pointer can travel straight up onto the card without dropping :hover.
         Narrow (not full preview width) so sliding off the dot drops the
         preview; interactive only while the dot is hovered, so it never blocks
         the scrubber. Height is exactly the preview's 18px offset less the dot's
         6px glyph, landing ON the dot's top edge (#158) - at 22px it ran 1px
         into the bar and stole presses meant for it. */
      .${PREVIEW_CLASS}::before {
        content: '';
        position: absolute;
        /* Anchored over the DOT, not the card centre, so the pointer can still
           travel dot-to-card after a clamp shift moves the card off its dot. */
        left: calc(50% - var(--ytb-preview-shift, 0px));
        transform: translateX(-50%);
        width: 16px;
        top: 100%;
        height: 12px;
        pointer-events: none;
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
        opacity: 1;
        transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px))) scale(1);
      }
      .${DOT_CLASS}:hover .${PREVIEW_CLASS}::before {
        pointer-events: auto;
      }
      /* Every preview kind accepts a click anywhere on it, bubbling to the dot's
         handler; the Reaction preview stays transparent but is clickable too. */
      .${DOT_TEXT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_TEXT_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:focus-visible .${PREVIEW_CLASS} {
        pointer-events: auto;
        cursor: pointer;
      }
      /* Reactions keep the transparent over-video treatment (not a card). They
         share the grid above; the emoji takes a full-width row beneath the
         timestamp's, keeping it centred over the dot while the corner timestamp
         stays clear (#158). */
      .${PREVIEW_CLASS}.ytb-preview-reaction {
        border: 0;
        background: transparent;
        box-shadow: none;
        color: #fff;
        box-sizing: border-box;
        min-width: 52px;
        text-align: center;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
      }
      /* Pinned top-right on both card kinds via grid placement (row 1, right
         column) rather than absolute positioning, so it reserves its own width. */
      .ytb-preview-time {
        grid-column: 2;
        grid-row: 1;
        justify-self: end;
        align-self: start;
        white-space: nowrap;
        color: var(--ytb-ink-muted);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ytb-preview-reaction .ytb-preview-time { color: #eee; }
      /* Content is the hero, author small beneath. Body shares row 1 with the
         timestamp and owns the left column. */
      .ytb-preview-body,
      .ytb-preview-spoiler {
        grid-column: 1;
        grid-row: 1;
        min-width: 0;
      }
      .ytb-preview-body {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      /* Everything under row 1 spans the full card, so the timestamp column
         constrains the body only - never the author or the Reply count. */
      .ytb-preview-author,
      .ytb-preview-replies,
      .ytb-preview-emoji,
      .ytb-preview-emoji-author {
        grid-column: 1 / -1;
      }
      .ytb-preview-author { margin-top: 4px; font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-preview-replies { margin-top: 4px; color: var(--ytb-accent-800); font-size: 11px; font-weight: 700; }
      .ytb-preview-spoiler { color: var(--ytb-ink-muted); font-style: italic; font-weight: 600; }
      .ytb-preview-emoji { grid-row: 2; font-size: 26px; line-height: 1.1; }
      .ytb-preview-emoji-author { margin-top: 2px; color: #eee; font-size: 11px; font-weight: 700; }

      /* Expanded Note: opaque warm surface. Entrance is a JS FLIP (flipPanelOpen)
         growing the panel out of what it replaced, so no pop-in keyframe here
         (ytb-pop-in still animates Replies and the delete confirm). */
      #${PANEL_ID} {
        position: absolute;
        z-index: 2100;
        box-sizing: border-box;
        padding: 16px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-lg);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        box-shadow: var(--ytb-e-dialog);
        font: 13px/1.45 var(--ytb-font);
        text-align: left;
        -webkit-user-select: text;
        user-select: text;
      }
      #${PANEL_ID}:focus { outline: none; }
      #${PANEL_ID} button,
      #${PANEL_ID} .ytb-panel-spoiler,
      #${PANEL_ID} .ytb-panel-emoji {
        -webkit-user-select: none;
        user-select: none;
      }
      @keyframes ytb-pop-in {
        from { opacity: 0; transform: scale(0.96) translateY(4px); }
      }
      /* The Note's video timestamp, pinned top-right (matching the Note Preview's
         corner timestamp); every panel variant reserves room for it. */
      .ytb-panel-time {
        position: absolute;
        top: 12px;
        right: 16px;   /* matches the panel's content inset (UA-024) */
        color: var(--ytb-ink-muted);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ytb-panel-body { margin: 0; padding-right: 42px; font-size: 15px; line-height: 1.4; font-weight: 700; overflow-wrap: anywhere; }
      /* Locked Spoiler variant: the masked body, muted and italic like its preview. */
      .ytb-panel-spoiler { margin: 0; padding-right: 42px; font-size: 15px; line-height: 1.4; font-weight: 600; font-style: italic; color: var(--ytb-ink-muted); }
      /* Reaction variant: the large emoji with its author directly beneath, mirroring the Note Preview. */
      .ytb-panel-emoji { font-size: 32px; line-height: 1.15; padding-right: 42px; }
      .ytb-panel-emoji-author { margin-top: 4px; font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-byline {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-top: 4px;
      }
      .ytb-panel-author { font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-posted { color: var(--ytb-ink-muted); font-size: 11px; white-space: nowrap; }
      .ytb-panel-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 12px;
      }
      /* Go here: the one apricot primary in the panel. */
      .ytb-panel-gohere {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 8px 12px;
        border: 0;
        border-radius: var(--ytb-r-pill);
        background: var(--ytb-accent-500);
        color: var(--ytb-on-accent);
        font: 700 13px/1 var(--ytb-font);
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
        color: var(--ytb-ink-muted);
        font: 600 13px/1 var(--ytb-font);
        cursor: pointer;
        transition: color var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-delete:hover, .ytb-panel-delete:focus-visible { color: var(--ytb-danger-text); outline: none; }
      .ytb-panel-delete:focus-visible { box-shadow: 0 0 0 3px var(--ytb-ring); }
      .ytb-panel-replies {
        max-height: 180px;
        overflow-y: auto;
        margin-top: 12px;
        border-top: 1px solid var(--ytb-line);
      }
      .ytb-panel-replies:empty { margin-top: 0; border-top: 0; }
      .ytb-panel-reply { padding: 8px 0 4px; }
      .ytb-panel-reply.ytb-new { animation: ytb-pop-in var(--ytb-dur-slow) var(--ytb-ease-spring); }
      .ytb-panel-reply-body { margin: 0; overflow-wrap: anywhere; }
      .ytb-panel-reply-byline { display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; }
      .ytb-panel-reply-author { font-size: 11px; font-weight: 700; color: var(--ytb-ink-muted); }
      .ytb-panel-reply-time { color: var(--ytb-ink-muted); font-size: 11px; white-space: nowrap; }
      .ytb-panel-reply-area { margin-top: 12px; }
      .ytb-panel-composer { position: relative; display: flex; align-items: flex-end; gap: 8px; }
      .ytb-panel-reply-input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        padding: 8px 12px;
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
      .ytb-panel-reply-note { margin: 4px 0 0; color: var(--ytb-ink-muted); font-size: 11px; }
      .ytb-panel-error { min-height: 16px; margin-top: 8px; color: var(--ytb-danger-text); font-size: 11px; font-weight: 600; }
      /* Delete confirmation: cream sub-panel with the danger-button treatment. */
      .ytb-panel-confirm {
        margin-top: 12px;
        padding: 12px;
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
        font: 700 13px/1.3 var(--ytb-font);
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
        font: 600 13px/1.3 var(--ytb-font);
        cursor: pointer;
        transition: background var(--ytb-dur-quick) var(--ytb-ease-out);
      }
      .ytb-panel-confirm-cancel:hover { background: var(--ytb-accent-050); }
      .ytb-panel-confirm-delete:disabled, .ytb-panel-confirm-cancel:disabled { opacity: 0.5; cursor: default; }
      .ytb-panel-confirm-delete:focus-visible, .ytb-panel-confirm-cancel:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ytb-ring); }

      /* Playback Notifications: placement and main axis are inline via
         applyAlertsPosition; only the static look lives here. */
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
        padding: 8px 12px;
        border: 1px solid var(--ytb-line);
        border-radius: var(--ytb-r-md);
        background: var(--ytb-surface);
        color: var(--ytb-ink);
        font: 13px/1.4 var(--ytb-font);
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
        /* Duration set per element (showReactionBurst); longhands here leave it
           untouched so reduced-motion below can swap only the animation name. */
        animation-name: ytb-burst;
        animation-timing-function: ease-out;
        animation-fill-mode: forwards;
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
        /* The Cluster fan is a reachability affordance, not decoration - it still
           applies, just snapping instead of animating. */
        .${DOT_CLASS} { transition: none; }
        /* Note Preview's unfold collapses to a plain opacity fade: the centring
           translate (plus clamp shift, #181) stays constant, scale is dropped.
           The Expanded Note's FLIP is skipped in JS on this same query. */
        .${PREVIEW_CLASS},
        .${DOT_CLASS}:hover .${PREVIEW_CLASS},
        .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
          transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px)));
          transition: opacity var(--ytb-dur-quick) linear;
        }
        /* Unseen: a static ring replaces the looping halo, held off the dot by a
           1px near-black gap (UA-026) - flush, an apricot ring scores as low as
           1.06:1 against some Buddy Colors and reads as one fatter dot, but the
           gap carries >= 3.69:1 separation instead. Reduced-motion viewers have
           no pulse, so this ring is their only Unseen cue; still box-shadow only. */
        .${DOT_UNSEEN_CLASS} {
          animation: none;
          box-shadow:
            0 0 0 1px ${UNSEEN_RING_GAP},
            0 0 0 3px var(--ytb-accent-500);
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
