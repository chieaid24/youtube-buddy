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
A Buddy's timestamped comment or emoji, pinned to one moment in one video, visible to the whole Room (like Progress Records). One entity with two content kinds: a text Note (limited to 100 characters), or an emoji **Reaction** (chosen from a small curated set, parallel to the eight curated Buddy Colors). Distinct from a Buddy's position **marker** (marker = live watch position; Note = authored content left at a moment). A text Note may be marked a **Spoiler**, showing only an obscured dot on the timeline until the viewer's own playhead passes its timestamp; while locked, it cannot be previewed or expanded. Clicking a locked Spoiler dot performs **Go here** (seeks to just before its timestamp and resumes playback) instead of doing nothing, so the viewer can jump to the moment and let the Note reveal naturally as the playhead crosses it; it is still neither previewed nor expanded while locked. Reactions are never Spoilers.
_Avoid_: comment (alone, ambiguous with generic web comments), tag, marker, pin

**Video Timeline**:
The active YouTube player's progress bar, where Progress Record markers and timestamped Notes appear. This is distinct from YouTube's home, search, recommended, and subscription feed surfaces. A newly posted Note appears immediately on the current Video Timeline after the post succeeds, without waiting for a refresh or polling cycle.
_Avoid_: feed (when referring to the active player's progress bar), scrubber

**Note Preview**:
The compact, hover-only summary shown above a Note on the Video Timeline. Content comes first with the author name beneath it (text body then author; Reaction emoji then author), the Note's video timestamp is pinned in the top-right corner, and it may summarize how many Replies the Note has. A transparent hover bridge keeps it alive so the pointer can travel from the dot onto the card to open the Expanded Note. It is not an interactive editing surface. A locked Spoiler shows only "Spoiler" — no author or timestamp.
_Avoid_: expanded mode, popup (ambiguous with the composer and playback notifications)

**Expanded Note**:
The pinned, interactive panel opened from a Note's dot or Note Preview. It shows the full Note conversation and Note actions. Opening it pauses the video at the viewer's current playhead position; it does not seek to the Note's timestamp. One of its Note actions is **Go here**: an explicit control that seeks playback to roughly one second before the Note's timestamp and resumes playing (then closes the panel), so the Note reveals through its own Playback Notification as playback reaches it. This is distinct from merely opening the Expanded Note, which still never seeks.
_Avoid_: hover state, Note Preview

**Reply**:
A text-only message appended to one parent Note and shown as part of that Note's conversation in the Expanded Note. Replies are limited to 100 characters, and one Note can have at most 10 Replies. Reactions are standalone timeline events and cannot have Replies.
_Avoid_: Note (a Reply has no independent timeline position), Reaction, generic comment

**Playback Notification**:
The transient bottom-center presentation triggered whenever ordinary forward playback crosses a Note or Reaction timestamp. A text Note uses a clickable card that can open its Expanded Note; a Reaction uses a non-interactive animated emoji treatment.
_Avoid_: Note Preview, Expanded Note, popup (ambiguous)

**Room Home Section**:
The compact panel the extension injects at the top of the YouTube **home page** (the recommendations grid on `youtube.com`), above the grid, which shifts down. It holds the Room Feed on the left and the Shared Playlist on the right, styled to match YouTube's home layout and kept deliberately short — small and scrollable, never a tall block. It is a distinct surface from the action popup and the Video Timeline (see ADR-0005). When Unpaired it shows a compact Create/Join prompt instead of the Feed + Playlist.
_Avoid_: home widget, dashboard, feed (alone)

**Shared Playlist**:
One Room-level list of videos — at most one Shared Playlist per Room — holding up to 30 Playlist Items, newest-added first. Any member may add or remove any video; there is no per-item ownership. Adding a video already present is a no-op; adding when the list is full is rejected (a member must remove one first). Rendered as a horizontal row of thumbnails on the right of the Room Home Section.
_Avoid_: queue, watch later, saved videos

**Playlist Item**:
One video in the Shared Playlist: its videoId, a title captured at add time, and the adding member's Client ID plus a timestamp. Under each item the Room Home Section shows who has watched it ("watched by You, Bob, and 1 other"), derived live from the Room's Progress Records for that videoId — so "watched" means "has a Progress Record" (started, not finished), and the attribution disappears when a member leaves or their record expires. Naming rule: "You" first (only when you personally have a record), then up to two Buddy Display Names, then "and N other(s)"; blank-name members use the "<Adjective> Buddy" fallback.
_Avoid_: playlist entry, video record

**Room Feed**:
The personalized, chronological, chat-like feed on the left of the Room Home Section. For the viewer it shows: Replies to Notes the viewer authored, and Notes or Replies that Mention the viewer — plus deemphasized System Messages for Shared Playlist changes. Items are grouped under day dividers (Today / Yesterday / date), oldest at the top and newest at the bottom, auto-scrolled to newest like a chat. There is **no** read/unread state: the Feed simply shows the most recent activity. It is derived entirely on the client from the Room read plus Playlist Events; nothing is stored per-recipient.
_Avoid_: inbox, notifications (as a stored entity), activity log

**Mention**:
An @-reference inside a Note or Reply that targets a specific Room member. Because Display Names are non-unique and cosmetic (identity is the Client ID), a Mention is resolved to and stored as the target's Client ID, never matched by name text (see ADR-0006). The author types "@", picks from a fuzzy-searchable roster of current Room members shown below the field, and the resulting Note/Reply carries a mentions list of Client IDs. A member is Mentioned when their Client ID appears in that list; the inline text still renders "@<Display Name>".
_Avoid_: tag, ping, at-name (as the stored form)

**System Message**:
A small, deemphasized Room Feed line describing a Shared Playlist change — a video added or removed, and by whom ("Bob added <title>", "You removed <title>"). Rendered visually quieter than personal Feed items. Backed by Playlist Events.
_Avoid_: notification, alert, toast

**Playlist Event**:
The backend event-log record behind System Messages: one row per Shared Playlist add or removal (`{ type: 'added' | 'removed', videoId, actorClientId, at }`), aged out on the shared 14-day TTL and capped to the newest ~50, returned alongside the Room read. Distinct from a Playlist Item (the current membership of the list) — an Event is the immutable history of a change.
_Avoid_: log entry, activity record
