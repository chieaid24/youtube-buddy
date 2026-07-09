# Unseen Mentions and Replies pulse on the Video Timeline, not by seeking

## Context

The Room Feed's Note/Reply/Mention rows link to the video. Until now, clicking one:

1. navigated to `/watch?v=<id>&t=<the Note's timestamp>` — seeking you to the moment,
2. wrote a `pendingNoteOpen` handshake so `notes.js` auto-opened that Note's Expanded
   Note on arrival, and
3. re-paused the video through a load-churn grace so autoplay could not dismiss the panel.

Three problems with that. It **teleports you into the middle of a video you may never have
watched**, discarding your own position. The panel it opens **covers the very timeline it is
anchored to**. And it is a one-shot: a Mention you never clicked through from the Feed never
announces itself on the video at all, because nothing tracks whether you have seen it. The
Feed was explicitly specified with no read/unread state, so "have I seen this?" was
unanswerable anywhere in the product.

Two shapes were on the table for tracking seen-ness:

- **(a) Per-recipient backend rows** — a new KV key shape and write route recording, per
  member, which Notes and Replies they have seen. Syncs across a member's browsers.
- **(b) Client-local seen state** — a private, per-install, Room-scoped set in
  `chrome.storage.local`, keyed by Note/Reply id.

## Decision

We chose **(b)**, and we replaced the seek-and-open arrival with a **pulse**.

- **A Feed row hands you the video, not the moment.** The anchor is `/watch?v=<id>` with
  **no `&t=`**, so YouTube's own resume position decides where you land — your place if you
  have watched it, the beginning if you have not. The extension performs no seek.

- **The Expanded Note no longer auto-opens on arrival.** `pendingNoteOpen` and its TTL are
  deleted. The Feed row instead writes a short-lived arrival handshake naming only the
  videoId.

- **Arrival is paused, and quiet.** On reaching that video, if Notes Visibility is on and at
  least one Unseen item is anchored to a Note on it, the video is paused (holding through
  autoplay's settling `play`, reusing the existing load-churn grace). Otherwise the
  handshake is consumed and nothing happens — no mystery pause with nothing to look at.

- **Unseen Note Dots pulse, whenever they are Unseen.** The pulse is a pure function of
  unseen state, not of how you arrived, so a Mention you never clicked in the Feed still
  announces itself the next time you open that video. The dot renders an expanding apricot
  halo (`box-shadow`, ~1.6s loop); the 10px dot never moves or resizes, so it cannot collide
  with a neighbour at `spreadFractions`' 11px minimum gap. Under `prefers-reduced-motion` it
  degrades to a static apricot ring.

- **Unseen is anchored to a Note Dot**, and is exactly the set the Room Feed surfaces:
  - a Note that Mentions you is Unseen while its id is not in the seen set;
  - a Reply is Unseen while its id is not in the seen set and it is not yours and either its
    parent Note is yours or it Mentions you;
  - a Note Dot is Unseen while the Note is an Unseen Mention **or** any Reply beneath it is
    Unseen.

  Reactions carry no Mentions (`composer.js` sends `mentions` only for `kind === 'text'`) and
  take no Replies, so a Reaction never pulses. A locked Spoiler can.

- **Three equivalent Acknowledge triggers, all on the dot**: hovering it, opening its
  Expanded Note, or ordinary forward playback crossing its timestamp. Acknowledging a dot
  clears **every** Unseen item anchored to it at once. Clicking the Feed row does not
  Acknowledge.

- **Seen state is pruned against each Room read** — ids no longer present in the Room (aged
  out on the 14-day TTL, or deleted) are dropped, so the set cannot grow without bound.

- **The Room Feed gains no unread affordance.** Its "no read/unread state" property stands:
  Unseen drives the Video Timeline only.

## Rationale

- Client IDs are per browser installation and never move across installs (CONTEXT.md), so
  cross-device sync of seen state has nothing to sync — the same person on a second browser
  is a different member. Per-recipient rows would buy nothing while costing a KV key shape,
  a write route, delete-cascade and TTL handling, and Room-cap accounting.
- Local seen state keeps the backend's **"nothing stored per-recipient"** invariant
  (ADR-0005, upheld again by the Dismiss layer in ADR-0007) intact. Seen-ness is a private
  local preference, structurally identical to a Dismiss and to Buddy Colors.
- Not seeking is the whole point of the change: a Mention is an invitation to look, not a
  command to jump. Pausing you at your own place, with the destination visibly pulsing, lets
  you choose — and preserves the Spoiler contract, which a forced seek to the Note's
  timestamp would quietly break by unlocking it.
- Omitting `&t=` rather than seeking to your own Progress Record keeps the extension out of
  playback positioning entirely. YouTube already owns "where was I", it is authoritative for
  the signed-in viewer, and a Progress Record can be absent (Sharing off) or staler than
  YouTube's own memory.
- Acknowledging on hover — even where hover reveals only a Reply _count_, or leaves a
  Spoiler masked — is deliberate. The pulse's job is to catch the eye, not to prove the
  message was read. One uniform rule on visually identical dots beats a truer rule the
  viewer cannot see.

## Consequences

- `pendingNoteOpen` / `PENDING_NOTE_OPEN_TTL_MS` and the auto-open branch of the panel load
  grace are removed. `PANEL_LOAD_GRACE_MS` survives, repurposed to hold the arrival pause.
- Reaching a Note's conversation from the Feed is now two acts: click the row, then click the
  pulsing dot. Accepted — the second click is the one that seeks (via **Go here**) and it is
  now the viewer's choice.
- Seen state does not follow a viewer to another browser, and a member who clears
  `chrome.storage.local` sees up to 14 days of Mentions pulse again. Both are accepted, and
  mirror Dismiss.
- The Video Timeline gains the product's **second** looping animation (the popup's breathing
  Waiting dot was the first). DESIGN.md section 2 is amended accordingly; both share the same
  ~1.6s rhythm.
- A Feed row clicked while Notes Visibility is off navigates plainly and silently. The
  viewer asked for zero Note UI; the Feed row honors it rather than overriding a setting.
