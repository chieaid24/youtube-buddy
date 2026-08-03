// extension/content/shared-notes.js
// Pure Note behavior on window.YTB: dot activation, panel variants, crossing
// detection, Picture Click routing (ADR-0011), and the Controls Hold
// (CONTEXT.md) notes.js and composer.js share.

(() => {
	const YTB = window.YTB;

	Object.assign(YTB, {
		// Copy for the author-only delete confirmation; a Note's delete cascades,
		// so this says exactly how many Replies go with it.
		deleteConfirmCopy(replyCount) {
			const count = Math.max(0, Math.floor(Number(replyCount) || 0));
			if (count === 0) return 'Really delete it?';
			return `Really delete it? This will also delete ${count === 1 ? '1 reply' : `${count} replies`}.`;
		},

		// "Go here" seeks ~1s before the Note (clamped at 0), so resuming crosses
		// it naturally and fires its own notification.
		goHereTarget(timestamp) {
			return Math.max(0, (Number(timestamp) || 0) - 1);
		},

		// Activating a Note Dot/Preview always OPENs its Expanded Note (Timeline
		// activation never seeks; Go here inside the panel is the only seek).
		dotActivation(_note) {
			return { action: 'open' };
		},

		// Playback Notification lifetimes; a Post Echo lives half (see
		// notificationLifetime).
		NOTE_CARD_MS: 4000,
		REACTION_BURST_MS: 2000,

		// Lifetime keyed on kind and trigger (not authorship): a crossing gets the
		// full lifetime, a Post Echo half - so a rewind-replay across your own
		// Note behaves like a Buddy's.
		notificationLifetime(kind, trigger) {
			const full = kind === 'emoji' ? YTB.REACTION_BURST_MS : YTB.NOTE_CARD_MS;
			return trigger === 'echo' ? full / 2 : full;
		},

		// Classify a click relative to YouTube's player: known controls are
		// chrome, the remaining player surface is the Video Picture. Callers
		// exclude their own overlay controls first.
		pictureClickRegion(target) {
			if (!target || typeof target.closest !== 'function') return 'outside';
			if (!target.closest('#movie_player, .html5-video-player')) return 'outside';
			if (
				target.closest(
					'.ytp-chrome-bottom, .ytp-chrome-top, .ytp-popup, .ytp-settings-menu, .ytp-panel-menu, button, a, input, select, textarea, [role="button"], [role="menu"], [role="menuitem"], [role="slider"]',
				)
			)
				return 'chrome';
			return 'picture';
		},

		// Route an overlay-open click (ADR-0011): a Press Origin of 'overlay' only
		// consumes the tail click; otherwise a Picture Click plays and closes,
		// player chrome closes without playing, off-player keeps Pause Hold semantics.
		pictureClickAction({ overlayOpen, region, pressOrigin, pauseHold, withinGrace }) {
			if (!overlayOpen)
				return {
					close: false,
					consume: false,
					play: false,
					cancelArrivalGrace: false,
				};
			if (pressOrigin === 'overlay') {
				return {
					close: false,
					consume: true,
					play: false,
					cancelArrivalGrace: false,
				};
			}
			if (region === 'picture') {
				return {
					close: true,
					consume: true,
					play: true,
					cancelArrivalGrace: Boolean(withinGrace),
				};
			}
			if (region === 'chrome') {
				return {
					close: true,
					consume: false,
					play: false,
					cancelArrivalGrace: false,
				};
			}
			return {
				close: true,
				consume: false,
				play: Boolean(pauseHold),
				cancelArrivalGrace: false,
			};
		},

		// What a video `play` does: inside the arrival grace (ADR-0010) it's
		// 'hold' (re-pause); otherwise it dismisses an open Expanded Note, or is ignored.
		playAction({ withinGrace, panelOpen }) {
			if (withinGrace) return 'hold';
			return panelOpen ? 'dismiss' : 'ignore';
		},

		// Re-feed period for YouTube's autohide timer, comfortably inside its ~3s window.
		CONTROLS_HOLD_TICK_MS: 1500,

		// The Controls Hold core (CONTEXT.md): a REFCOUNTED hold on YouTube's
		// control-bar autohide. Dots swallow pointer events, starving YouTube's
		// inactivity timer under a hovering hand; while any hold is live this
		// feeds that timer instead (immediate on first acquire, then ticked), and
		// the last release hands it straight back. `acquire()` returns a ONE-SHOT
		// release; dispatch/timers are injected seams so this is testable in workerd.
		createControlsHold({
			dispatch,
			tickMs = YTB.CONTROLS_HOLD_TICK_MS,
			setTimer = (fn, ms) => setInterval(fn, ms),
			clearTimer = (id) => clearInterval(id),
		}) {
			let holders = 0;
			let timer = null;
			let tick = 0;
			// Guarded so a queued tick or stray leftover timer can never feed after release.
			const feed = () => {
				if (holders === 0) return;
				dispatch(tick++);
			};
			return {
				acquire() {
					holders += 1;
					if (holders === 1) {
						feed(); // wake NOW - the parked pointer is invisible to YouTube
						timer = setTimer(feed, tickMs);
					}
					let released = false;
					return () => {
						if (released) return;
						released = true;
						holders -= 1;
						if (holders === 0 && timer !== null) {
							clearTimer(timer);
							timer = null;
						}
					};
				},
				holders: () => holders,
			};
		},

		// The real Controls Hold dispatch: a pixel-jittered synthetic `mousemove`
		// on the player root (never the progress bar, so no scrub preview fires).
		nudgePlayerControls(tick) {
			if (typeof document === 'undefined') return;
			const player = document.querySelector('#movie_player, .html5-video-player');
			if (!player) return;
			const rect = player.getBoundingClientRect();
			if (!(rect.width > 0) || !(rect.height > 0)) return;
			player.dispatchEvent(
				new MouseEvent('mousemove', {
					bubbles: true,
					cancelable: true,
					view: window,
					clientX: rect.left + rect.width / 2 + (tick % 2),
					clientY: rect.top + rect.height / 2 + (Math.floor(tick / 2) % 2),
				}),
			);
		},

		// Hover-scope a Controls Hold onto one overlay element. HOVER ONLY, never
		// keyboard focus - the Composer and Expanded Note auto-focus on open, so a
		// focus-scoped hold would pin the chrome for their whole lifetime. Returns
		// a one-shot teardown the caller's close path must call (the element
		// usually leaves the DOM without a final mouseleave).
		bindHoverHold(element) {
			let release = null;
			element.addEventListener('mouseenter', () => {
				release ||= YTB.controlsHold.acquire();
			});
			element.addEventListener('mouseleave', () => {
				release?.();
				release = null;
			});
			return () => {
				release?.();
				release = null;
			};
		},

		// Panel variant at open, given the viewer's playhead (pass Infinity with
		// no player): 'spoiler' = locked Spoiler (masked, read-only), 'reaction' =
		// emoji with author, 'text' = plain Note or UNLOCKED Spoiler (full conversation).
		notePanelVariant(note, playhead) {
			if (Boolean(note.spoiler) && Number(playhead) < Number(note.timestamp)) return 'spoiler';
			if (note.kind === 'emoji') return 'reaction';
			return 'text';
		},

		// Whether the paused playhead sits within GO_HERE_NEAR_SECONDS of the
		// Note's moment (Go here is then omitted). A non-finite playhead is never near.
		nearNoteMoment(timestamp, playhead) {
			const head = Number(playhead);
			if (!Number.isFinite(head)) return false;
			return Math.abs(head - Number(timestamp)) <= YTB.GO_HERE_NEAR_SECONDS;
		},

		// Notes whose timestamps forward playback just crossed
		// (previousTime < t <= currentTime), timestamp-sorted; the caller decides
		// whether the step was natural, so a replay after rewinding triggers again.
		crossedNotes(notes, previousTime, currentTime) {
			return (notes || [])
				.filter((note) => {
					const t = Number(note.timestamp);
					return Number.isFinite(t) && t > previousTime && t <= currentTime;
				})
				.sort((a, b) => a.timestamp - b.timestamp);
		},
	});

	// The ONE Controls Hold instance, on the YTB global so notes.js and
	// composer.js share the same refcount regardless of load order.
	YTB.controlsHold = YTB.createControlsHold({
		dispatch: (tick) => YTB.nudgePlayerControls(tick),
	});
})();
