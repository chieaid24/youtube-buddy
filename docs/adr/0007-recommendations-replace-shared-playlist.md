# Recommendations replace the Shared Playlist (room list minus own, client-local dismiss)

## Context

The Shared Playlist (ADR-0005) was one communal Room-level list that any member curates
freely. We are reframing it as directional **Recommendations**: any member recommends a
video "to all Buddies" using the same "+ Buddy Room" control, and each viewer's
**Recommended for you** list shows videos recommended by _others_. A member's own
recommendations are deliberately hidden from their own grid (you do not recommend to
yourself). The existing "Watched by ..." attribution is unchanged.

Two shapes were on the table:

- **(a) Per-recipient records** — one row per (recommender x recipient, video). Enables
  targeting a specific Buddy and server-synced per-recipient dismiss.
- **(b) Room list minus own** — keep the single Room-level list keyed by videoId; each
  viewer derives their grid from it.

## Decision

We chose **(b)**, with a client-local dismiss layer.

- **Storage is unchanged in shape.** A single Room-level list keyed by videoId
  (`{code}:playlist:{videoId}`, with `addedBy` = the recommender) remains the source of
  truth. There are no per-recipient rows. A viewer's Recommended-for-you grid is
  `items where addedBy != me`, minus that viewer's locally dismissed videoIds.

- **Two distinct removal acts:**
  1. **Un-recommend (author only).** The recommender deletes their own Room item via the
     watch-page "+ Buddy Room" pill toggle (which shows an "Unrecommend" action on videos
     they recommended). This removes it for _everyone_ and emits **no** Room Feed
     notification.
  2. **Dismiss (recipient, local).** A recipient hides a recommendation from just their
     own grid. Dismissals are stored in `chrome.storage.local`, Room-scoped, mirroring
     Buddy Color storage; they never leave the browser and never hit the backend.

- **The recommend event carries the video title.** Playlist Events gain a `title` field
  captured at recommend time, so the Room Feed message ("X recommended you \"Title\"")
  survives an un-recommend instead of decaying to "a video". Only "added" (recommend)
  events feed the Room Feed; **removals emit no event**.

- **The "a Buddy watched a video you recommended" Feed item is derived**, not stored. It
  is computed client-side from the Room read (a Buddy's Progress Record for one of your
  recommendations), timestamped by that record's `updatedAt`. Best-effort: it can reorder
  as the Buddy keeps watching, and it cannot distinguish watched-before vs watched-after
  the recommendation.

## Rationale

- You recommend to **all** Buddies (no targeting), and Client IDs never move across
  browser installs (no cross-device sync to gain), so per-recipient backend rows buy
  nothing the Room-list model lacks while costing more storage, duplicate rows, and a
  bigger rewrite. Room-list-minus-own reuses the existing storage and keeps natural
  videoId dedup with zero added read fan-out.
- Client-local dismiss keeps the backend's **"nothing stored per-recipient"** invariant
  (ADR-0005) intact — dismissal is a private local preference, exactly like Buddy Colors.
- Deriving the watch notice avoids adding a new event type and a dedup step on the hot
  Progress POST path; the best-effort weakness is accepted, consistent with the rest of
  the Room read.

## Consequences

- This **supersedes the "Shared Playlist" framing of ADR-0005**: the Room Home Section's
  right column becomes "Recommended for you". Backend KV infixes (`playlist:`, `event:`)
  and the `YTB` API names are **retained** (no data migration); only the domain terms and
  semantics change.
- A recommender manages and removes their own recommendations **only from the watch page**
  (they are hidden from their own grid); there is no in-section "You recommended" strip.
- Two removal semantics coexist and can confuse: un-recommend is global and permanent;
  dismiss is local. There is no un-dismiss UI initially (a dismissed video stays hidden in
  that Room for that install). Dismiss is keyed by videoId, so a later re-recommend does
  not resurface it. Both are noted as follow-ups.
- The Room Feed no longer shows "removed from the playlist" System Messages.

## Amendment (2026-07-08)

Two Feed-rendering consequences are revised; storage and the "removals emit no event"
decision are unchanged:

- The recommender now DOES see their own recommend line in the Room Feed ("You
  recommended \"Title\" to the Room"), sourced from the same `added` Event. The
  Recommended-for-you grid still hides own items.
- An un-recommend no longer leaves the recipient's Feed line looking live: the client
  derives removal (originally: the Event's videoId is absent from the Room's current
  Recommendation list — corrected by the 2026-07-09 amendment below to a per-Event rule,
  since videoId absence alone silently un-strikes a dead line once the video is
  re-recommended) and renders the existing System Message struck through. No `removed`
  event is introduced.

## Amendment (2026-07-09)

Strike-through is a **per-Event** state, not a per-video one. Under the 2026-07-08 rule,
recommend -> un-recommend -> re-recommend of one video put the videoId back in the live
Recommendation list, which silently un-struck the older, dead System Message — both
lines then read as live. An `added` Playlist Event is now struck when either holds:

1. a **newer** `added` Event exists for the same videoId (it was superseded), or
2. its videoId is absent from the Room's live Recommendation list (it is currently
   un-recommended).

Clause 1 rests on the backend's **no-op re-add invariant**: recommending a videoId that
is already live returns the existing item and emits no Event, so a second `added` Event
for one videoId can only come into existence after that videoId was deleted from the
list — every `added` Event for a video except the newest is therefore necessarily dead,
and the newest is dead exactly when clause 2 says so. Event eviction cannot break this:
the newest-50 cap evicts oldest-first and each Event's TTL starts at its own creation,
so a surviving Event can lose older siblings (harmless — fewer lines) but never its
newer one. Storage is unchanged: no `removed` event type, no `removedAt` field, no new
API surface, and un-recommends still emit no Event. Intended consequence: after
recommend -> un-recommend -> re-recommend the Feed shows two System Messages for that
video, the older struck, the newer live.

A struck line also stops pretending to be clickable: it renders **no anchor at all** —
the title is plain text in the line's own muted color (no accent, no bold weight, no
hover underline, no pointer cursor, no link tooltip), the sole exception to the Room
Feed's link rule. Because a line-through conveys nothing to a screen reader, a struck
row instead carries a "No longer recommended" tooltip and a visually-hidden
"(no longer recommended)" suffix inside the sentence.
