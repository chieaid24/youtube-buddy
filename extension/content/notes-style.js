// extension/content/notes-style.js
// The Note UI's class/id names and stylesheet, in one place; notes.js and
// notes-alerts.js consume YTBNotesUI.NAMES and notes.js calls injectStyle().
// Styling consumes the --ytb-* tokens theme.js injects; geometry numbers come
// from YTB.NOTE_BAND so CSS and the pure helpers never drift (#173).

(function () {
	'use strict';

	const NAMES = {
		DOT_CLASS: 'ytb-note-dot',
		DOT_TEXT_CLASS: 'ytb-note-dot-text',
		DOT_REACTION_CLASS: 'ytb-note-dot-reaction',
		DOT_LOCKED_CLASS: 'ytb-note-dot-locked',
		DOT_OPEN_CLASS: 'ytb-note-dot-open', // suppresses the open Note's own preview
		DOT_UNSEEN_CLASS: 'ytb-note-dot-unseen', // pulses the apricot halo (ADR-0010)
		DOT_PASSED_CLASS: 'ytb-note-dot-passed', // dims a Note once the playhead crosses it
		CLUSTER_CLASS: 'ytb-dot-cluster', // wrapper owning a Cluster's hover/fan (#123)
		CLUSTER_PINNED_CLASS: 'ytb-dot-cluster-pinned', // stays fanned while its Note's panel is open
		TOOLTIP_SUPPRESSED_CLASS: 'ytb-note-tooltip-suppressed', // hides YouTube's stale storyboard under a hovered Cluster
		PREVIEW_CLASS: 'ytb-note-preview',
		PANEL_ID: 'ytb-note-panel',
		ALERTS_ID: 'ytb-note-alerts',
	};

	const STYLE_ID = 'ytb-notes-style';
	const BAND = YTB.NOTE_BAND;
	const DOT_DIAMETER = BAND.dotDiameter;
	// Separates the reduced-motion Unseen ring from the Buddy-colored fill (UA-026).
	const UNSEEN_RING_GAP = '#0f0f0f';

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
		ALERTS_ID,
	} = NAMES;

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
      /* Dot Cluster (#123): owns hover/focus for dots that overlap at rest.
         Anchored at the Cluster centre in bar px, re-measured every render
         (#159); pointer-events:none at rest (only member dots catch the
         pointer), but a hovered ::before keeper spans the fanned band.
         Every interactive surface lives STRICTLY ABOVE the bar's top edge
         (#158) so the bar stays seekable; inside the Note Band our z-index 44
         outranks YouTube's measured stack (scrubber knob at 43, #173) - the
         knob stays fully grabbable on the bar itself, only its overlap INTO
         the band is conceded. */
      .${CLUSTER_CLASS} {
        position: absolute;
        bottom: calc(100% + ${BAND.dotLift}px);
        width: 0;
        height: ${DOT_DIAMETER}px;
        z-index: 44;
        pointer-events: none;
      }
      /* Hover keeper: reaches from above the dots down to FLUSH with the bar's
         top edge (#158) - no dead strip, so travelling into a fan never crosses
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
      /* Fan members apart on hover/focus/pinned - a transform only, so the base
         left offset never changes and it reverses instantly. */
      .${CLUSTER_CLASS}:hover > .${DOT_CLASS},
      .${CLUSTER_CLASS}:focus-within > .${DOT_CLASS},
      .${CLUSTER_CLASS}.${CLUSTER_PINNED_CLASS} > .${DOT_CLASS} {
        transform: translateX(var(--ytb-fan, 0px));
      }

      /* A flat, single-color circle just clear of the bar's top edge. No
         border/ring/shadow - a pale dot over a bright frame is the accepted trade. */
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
        /* Re-assert auto: pointer-events is inherited from the none wrapper. */
        pointer-events: auto;
        transform: translateX(0);
        transition: transform var(--ytb-dur-base) var(--ytb-ease-spring);
      }
      /* Invisible hit extender (UA-004, #202): per-side reach set by JS. Grows
         UPWARD off the dot's bottom edge (#158) - a centred box hung into the
         bar stole presses near a Note's timestamp. */
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
      /* Locked Spoilers veil via an overlay, not filter/opacity, which would
         also gray the Unseen halo and hover preview on this same element. */
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

      /* Unseen pulse (ADR-0010): box-shadow only, so neighbouring dots are
         never displaced; shares the popup Waiting dot's breathing rhythm. */
      .${DOT_UNSEEN_CLASS} {
        animation: ytb-unseen-pulse 1.6s var(--ytb-ease-out) infinite;
      }
      @keyframes ytb-unseen-pulse {
        from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ytb-accent-500) 75%, transparent); }
        to   { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ytb-accent-500) 0%, transparent); }
      }
      /* An open panel's own hover preview hides INSTANTLY, vanishing on the
         first frame of the Expanded Note that grows out of it. */
      .${DOT_OPEN_CLASS} .${PREVIEW_CLASS} {
        opacity: 0 !important;
        transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px))) scale(0.6) !important;
        transition: none !important;
        pointer-events: none !important;
      }

      /* Note Preview: opaque warm card that unfolds OUT OF the dot on hover -
         transform-origin sits 15px below the card (18px bottom gap less the
         dot's 3px half-height); reduced-motion collapses it to an opacity fade. */
      .${PREVIEW_CLASS} {
        position: absolute;
        bottom: 18px;
        left: 50%;
        /* --ytb-preview-shift (clampPreview, #181) slides a card back inside
           the player's edges near the bar's ends; the origin subtracts the same
           shift so the unfold still grows out of the dot. */
        transform-origin: calc(50% - var(--ytb-preview-shift, 0px)) calc(100% + 15px);
        transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px))) scale(0.6);
        /* Two auto columns - content, then the corner timestamp (#158), a real
           grid item that reserves its own width: a max-content card widens to
           fit body + time; past the cap the body wraps/line-clamps instead. */
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
      /* Transparent hover bridge over the DOT (not the card centre, so it works
         after a clamp shift): narrow so sliding off the dot drops the preview,
         interactive only while the dot is hovered, and ending ON the dot's top
         edge (#158) - at 22px it ran 1px into the bar and stole presses. */
      .${PREVIEW_CLASS}::before {
        content: '';
        position: absolute;
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
      /* Every preview kind accepts a click anywhere on it, bubbling to the dot. */
      .${DOT_TEXT_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_TEXT_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_LOCKED_CLASS}:focus-visible .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:hover .${PREVIEW_CLASS},
      .${DOT_REACTION_CLASS}:focus-visible .${PREVIEW_CLASS} {
        pointer-events: auto;
        cursor: pointer;
      }
      /* Reactions keep the transparent over-video treatment (not a card); the
         emoji takes a full-width row beneath the corner timestamp's (#158). */
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
      /* Corner timestamp via grid placement (row 1, right column), never an
         absolute overlay, so it reserves its own width. */
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
      /* Body shares row 1 with the timestamp and owns the left column. */
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
         constrains the body only. */
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

      /* Expanded Note: opaque warm surface. Entrance is a JS FLIP (flipPanelOpen),
         so no pop-in keyframe here (ytb-pop-in still animates Replies/confirm). */
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
      /* The Note's video timestamp, pinned top-right on every variant (matching
         the Note Preview's corner timestamp). */
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
      /* Reaction variant: the large emoji with its author directly beneath. */
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

      /* Playback Notifications: placement and main axis are inline (notes-alerts.js);
         only the static look lives here. */
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
        /* The Cluster fan is a reachability affordance, not decoration - it
           still applies, just snapping instead of animating. */
        .${DOT_CLASS} { transition: none; }
        /* Note Preview's unfold collapses to a plain opacity fade; the Expanded
           Note's FLIP is skipped in JS on this same query. */
        .${PREVIEW_CLASS},
        .${DOT_CLASS}:hover .${PREVIEW_CLASS},
        .${DOT_CLASS}:focus-visible .${PREVIEW_CLASS} {
          transform: translateX(calc(-50% + var(--ytb-preview-shift, 0px)));
          transition: opacity var(--ytb-dur-quick) linear;
        }
        /* Unseen: a static ring replaces the looping halo, held off the dot by
           a 1px near-black gap (UA-026) - flush, an apricot ring can score as
           low as 1.06:1 against some Buddy Colors and reads as one fatter dot;
           the gap carries >= 3.69:1 separation. Still box-shadow only. */
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

	window.YTBNotesUI = { NAMES, injectStyle };
})();
