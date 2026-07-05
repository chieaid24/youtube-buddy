# YouTube Buddy

A Chrome extension plus Cloudflare Worker backend that lets a small Room of friends (up to five) passively share YouTube watch progress — each sees where the others left off, both on the active video's progress bar and on thumbnails.

## Language

**Room Code**:
A short shared string that forms a Room. Newly generated Room Codes use a `<descriptor>-<plural-animal>` slug (e.g. `red-frogs` or `jumping-spiders`), shown as "The Red Frogs" or "The Jumping Spiders", and are checked against existing Rooms so a fresh code is never handed out already-in-use; the rare fallback when no clean slug is free appends a 3-digit number (`red-frogs-742`). Joined codes remain permissive and need not match the generated-code vocabulary — but joining requires the Room Code to already exist: at least one presence row or Progress Record must already be stored under it (i.e. someone else created it first). Typing an unknown code is rejected rather than silently creating a new empty Room. A Room Code is both the joining mechanism and the only access control — anyone holding the code can read and write that Room's data.
_Avoid_: friend code, group code, secret (the people form a _Room_, but the string itself is always the _Room Code_)

**Room**:
The set of people sharing one Room Code — at most five (you plus up to four Buddies). The backend enforces the cap best-effort; a sixth person is locked out. Leaving removes that member's presence and all of their Progress Records from the Room, freeing their slot immediately.
_Avoid_: group, channel, party

**Progress Record**:
One user's last-known position in one specific video. A user has many Progress Records (one per video watched); old ones expire rather than living forever, and all are deleted when that user leaves the Room.
_Avoid_: progress entry, watch state, sync record

**Client ID**:
A random stable identifier generated once per browser installation. It is what identifies a user within a Room; two users can share a Display Name without colliding.
_Avoid_: user id, username

**Display Name**:
The human-readable label a user types for themselves (e.g. "aidan"), shown beside their markers. Purely cosmetic — carries no identity. The popup's field label reads "Nickname" (friendlier UI copy); the term itself stays Display Name in code, config keys, and docs.
_Avoid_: name (alone, in code), handle

**Buddy** (pl. **Buddies**):
Any other person in your Room — there can be up to four. Their Progress Records get rendered in your browser using the Buddy Color that you assigned to them for that Room.
_Avoid_: friend, peer, partner (in code and UI copy; "friend" is fine in prose)

**Buddy Color**:
One of eight curated colors used to render a Buddy's progress for one viewer. A new Buddy receives a random currently available color. The viewer can change it by clicking the color beside that Buddy's Display Name. Assignments are private to that browser and scoped to the Room Code. A color already assigned to another current Buddy in the same Room is unavailable; the same color may be used independently in another Room or browser. The assignment is discarded when the Buddy leaves, so a later rejoin receives a new random available color.
_Avoid_: palette, global color, shared color

**Room states** (Unpaired / Waiting / In room / Room full):
Your membership in a Room, from your perspective. _Unpaired_ — no code. _Waiting_ — code set, but no Buddy has joined or recorded yet. _In room_ — at least one Buddy is present, via a presence row or a Progress Record (the popup lists each Buddy with their color swatch + last-seen). _Room full_ — five other Client IDs already exist under the code and you are not one of them, so you are the locked-out sixth: nothing renders.
_Avoid_: paired, connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. Pausing sharing never stops _seeing_ the Buddies' markers.
_Avoid_: broadcasting, syncing (which also covers reads)

**Note**:
A Buddy's timestamped comment or emoji, pinned to one moment in one video, visible to the whole Room (like Progress Records). One entity with two content kinds: a text Note (limited to 100 characters), or an emoji **Reaction** (chosen from a small curated set, parallel to the eight curated Buddy Colors). Distinct from a Buddy's position **marker** (marker = live watch position; Note = authored content left at a moment). A text Note may be marked a **Spoiler**, showing only an obscured dot on the timeline until the viewer's own playhead passes its timestamp; while locked, it cannot be previewed or expanded. Reactions are never Spoilers.
_Avoid_: comment (alone, ambiguous with generic web comments), tag, marker, pin

**Video Timeline**:
The active YouTube player's progress bar, where Progress Record markers and timestamped Notes appear. This is distinct from YouTube's home, search, recommended, and subscription feed surfaces. A newly posted Note appears immediately on the current Video Timeline after the post succeeds, without waiting for a refresh or polling cycle.
_Avoid_: feed (when referring to the active player's progress bar), scrubber

**Note Preview**:
The compact, hover-only summary shown above a Note on the Video Timeline. It identifies the author before the Note text and may summarize how many Replies the Note has. It is not an interactive editing surface.
_Avoid_: expanded mode, popup (ambiguous with the composer and playback notifications)

**Expanded Note**:
The pinned, interactive panel opened from a Note's dot or Note Preview. It shows the full Note conversation and Note actions. Opening it pauses the video at the viewer's current playhead position; it does not seek to the Note's timestamp.
_Avoid_: hover state, Note Preview

**Reply**:
A text-only message appended to one parent Note and shown as part of that Note's conversation in the Expanded Note. Replies are limited to 100 characters, and one Note can have at most 10 Replies. Reactions are standalone timeline events and cannot have Replies.
_Avoid_: Note (a Reply has no independent timeline position), Reaction, generic comment

**Playback Notification**:
The transient bottom-center presentation triggered whenever ordinary forward playback crosses a Note or Reaction timestamp. A text Note uses a clickable card that can open its Expanded Note; a Reaction uses a non-interactive animated emoji treatment.
_Avoid_: Note Preview, Expanded Note, popup (ambiguous)
