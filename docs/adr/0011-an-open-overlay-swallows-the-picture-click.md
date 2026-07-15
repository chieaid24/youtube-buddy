# An open on-video overlay swallows the Picture Click; YouTube never toggles

## Context

Both on-video overlays -- the Expanded Note and the Note Composer -- take a Pause Hold when they
open over a playing video, and release it when they close: an outside click resumes the video only
if opening it paused a playing one.

That release fights YouTube. Clicking the Video Picture is also YouTube's own play/pause toggle, and
YouTube defers that toggle (it must first rule out a double-click, which means fullscreen). So the
observed sequence with a panel open over a video WE paused was:

1. the viewer clicks the picture to get their video back;
2. our document-level click handler closes the panel and, honouring the Pause Hold, calls
   `video.play()`;
3. YouTube's deferred toggle then fires, sees a _playing_ video, and pauses it.

The viewer clicked the video to resume and the video stopped. Two writers, no defined order, and the
loser is whoever the host page schedules last -- an ordering we do not control and cannot depend on.

Restoring the pre-open state is also the wrong goal for this gesture. Clicking the picture is not a
dismissal of the panel; it is a statement about the video ("play this"). It should mean the same
thing whether or not the video happened to be playing when the note was opened.

Two shapes were on the table:

- **(a) Cooperate and correct** -- let YouTube's toggle run, observe the resulting state, and
  re-assert play afterwards. Keeps double-click-to-fullscreen intact, but leaves two writers racing,
  produces a visible pause/play flicker, and encodes an assumption about YouTube's internal timing
  that a player refactor silently breaks.
- **(b) Take the click** -- while an overlay is open, intercept the click on the Video Picture in the
  capture phase, `preventDefault()` + `stopPropagation()` so YouTube never sees it, then close the
  overlay and play, ourselves.

## Decision

**(b).** While an Expanded Note or a Note Composer is open, a Picture Click belongs to YTB. We take
it in the capture phase, YouTube's toggle never arms, and we are the single writer of playback state
for that gesture: close the overlay, cancel any arrival grace (ADR-0010), and play -- unconditionally,
regardless of the Pause Hold or of what the video was doing before the overlay opened.

The interception is scoped as narrowly as it can be:

- **Only while an overlay is open.** With no Expanded Note and no Note Composer on screen, YouTube's
  click-to-pause behaves exactly as it always has. We add no handler to the normal watching path.
- **Only on the Video Picture.** A click on player chrome -- the control bar, the scrubber, the
  settings/captions menus, the theater and fullscreen buttons -- closes the overlay and then leaves
  playback strictly alone: the viewer is operating a control, and the control's meaning is YouTube's
  to define. We never force play there, and we do not release the Pause Hold into it either.
- **Only the click.** Clicking off the player entirely (comments, sidebar, page background) and
  pressing Escape keep Pause Hold semantics: they restore the pre-open state, because they are
  dismissals of the overlay and say nothing about the video.

A Picture Click also beats ADR-0010's arrival grace, which re-pauses a video that a Room Feed row
paused on arrival. That grace exists to swallow the watch page's _automatic_ play as it settles; an
explicit click is unambiguously the viewer, so it cancels the grace rather than being held by it.

## Consequences

Playback after a Picture Click is deterministic and does not depend on YouTube's handler ordering,
its double-click disambiguation delay, or any future player refactor. "Click the video to get the
video back" always works, from every overlay, in every prior playback state.

The cost: **with an overlay open, a double-click on the picture no longer enters fullscreen.** The
first click is consumed by the close-and-play, so the gesture never completes. This is the price of
being the single writer, and it is deliberately paid -- an overlay is a modal-ish state whose first
click is spent dismissing it, and fullscreen remains one click away once the overlay is gone (and
untouched by the `f` hotkey and the fullscreen button throughout).

We also now suppress a native host-page interaction, which is the kind of thing that surprises the
next reader. That is the whole reason this is written down: the swallow is intentional, narrowly
scoped to an open overlay on the picture, and reversing it means going back to (a) and accepting the
race.

## Amendment: the matrix keys on the Press Origin, not only the click target

The decision above routes a click by _where it landed_. That is not enough, because a `click` event
does not report where the gesture began: press on one element, release on another, and the browser
fires the click on their **common ancestor**. Both overlays are mounted inside `#movie_player`, so
the common ancestor of "pressed in the Expanded Note, released on the video" is the player -- and the
matrix, reading only the target, classifies that as a Picture Click. Close the overlay, play the
video.

Nothing produces that gesture more reliably than selecting text: highlight a Note body, drag a few
pixels past the panel's edge, and the panel you were reading disappears. The same holds for a
selection dragged out of the Note Composer's textarea. So the swallow above, left as written, makes
the overlays' own content unhighlightable in practice -- the very thing the panel is for.

The fix stays inside the single routing matrix rather than growing a special case in `notes.js`: a
capture-phase `pointerdown` records the **Press Origin** (was the press inside the open overlay?),
and `YTB.pictureClickAction` takes it as an input. A gesture that began inside the overlay changes no
YTB state -- no close, no play, no grace cancellation -- whatever region it ends in, because it was
never a click _at_ the player; it was the tail of an interaction the overlay owns. YTB still consumes
that tail click so YouTube cannot reinterpret the common-ancestor click as a playback toggle. Both
`notes.js` and `composer.js` consume the same rule, so the Expanded Note and the Note Composer cannot
drift.

This narrows the swallow rather than widening it. The Picture Click keeps its full meaning for the
gesture it was written for -- a press AND release on the picture, which is unambiguously "play this
video" -- and gives back the one gesture it was never entitled to take.
