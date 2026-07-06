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
     watch-page "+ Buddy Room" pill toggle (which shows a "Recommended" state on videos
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
