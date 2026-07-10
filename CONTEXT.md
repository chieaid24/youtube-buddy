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
One of eight curated colors used to render a Buddy's progress for one viewer. A new Buddy receives a random currently available color. The viewer can change it by clicking the **Buddy Color Swatch** beside that Buddy's Display Name. Re-assigning a color repaints every surface that draws that Buddy — Progress Markers, thumbnail Progress Bars, Note Dots and Note Previews, an open Expanded Note's bylines, and Room Feed author names — immediately, in every open tab, without a reload or a navigation, the same live-follow way the Theme Preference applies (ADR-0008). Assignments are private to that browser and scoped to the Room Code. A color already assigned to another current Buddy in the same Room is unavailable; the same color may be used independently in another Room or browser. The assignment is discarded when the Buddy leaves, so a later rejoin receives a new random available color.
_Avoid_: palette, global color, shared color

**Room states** (Unpaired / Waiting / In room / Room full):
Your membership in a Room, from your perspective. _Unpaired_ — no code. _Waiting_ — code set, but no Buddy has joined or recorded yet. _In room_ — at least one Buddy is present, via a presence row or a Progress Record (the popup lists each Buddy with their color swatch + last-seen). _Room full_ — five other Client IDs already exist under the code and you are not one of them, so you are the locked-out sixth: nothing renders.
_Avoid_: paired, connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. Pausing sharing never stops _seeing_ the Buddies' markers.
_Avoid_: broadcasting, syncing (which also covers reads)

**Control Panel**:
The surface shown when the extension's toolbar icon is clicked — the extension's action popup. It holds identity (the Nickname / Display Name field), the Room Code entry with the current Room state, the per-Buddy list (each with its Buddy Color Swatch), and the click-to-toggle Sharing Dot. It is distinct from every in-page surface — the Video Timeline, the Note Composer, and the Room Home Section. All state it reads and writes lives in `chrome.storage.local`.
_Avoid_: popup (ambiguous with the Note Preview, Note Composer, and Playback Notification), settings page, dashboard

**Sharing Dot**:
The small click-to-toggle status indicator in the Control Panel that shows and flips Sharing on or off. Its color/state reflects Sharing only; turning it off never stops _seeing_ Buddies' markers.
_Avoid_: toggle, switch, status light

**Buddy Color Swatch**:
The small color control in the Control Panel, shown beside each Buddy's Display Name, that opens the eight-color picker to (re)assign that Buddy's Buddy Color for this Room (see Buddy Color). Private to one viewer and Room.
_Avoid_: color picker (alone), palette

**Note**:
A Buddy's timestamped comment or emoji, pinned to one moment in one video, visible to the whole Room (like Progress Records). One entity with two content kinds: a text Note (limited to 100 characters), or an emoji **Reaction** (chosen from a small curated set, parallel to the eight curated Buddy Colors). Distinct from a Buddy's position **Progress Marker** (a Progress Marker = live watch position; a Note = authored content left at a moment). A Note also captures its video's title at post time (best-effort, optional) so Room Feed lines can name the video it was left on. A text Note may be marked a **Spoiler**, showing only an obscured dot on the timeline until the viewer's own playhead passes its timestamp; while locked, both its Note Preview and its Expanded Note mask the body (a muted "Spoiler") and withhold the conversation. Clicking any Note Dot or Note Preview — text, Reaction, or locked Spoiler — opens that Note's Expanded Note and never seeks or changes playback by itself; jumping to the moment is always the explicit **Go here** action inside the panel. Reactions are never Spoilers.
_Avoid_: comment (alone, ambiguous with generic web comments), tag, marker, pin

**Video Timeline**:
The active YouTube player's progress bar, where Progress Record markers and timestamped Notes appear. This is distinct from YouTube's home, search, recommended, and subscription feed surfaces. A newly posted Note appears immediately on the current Video Timeline after the post succeeds, without waiting for a refresh or polling cycle.
_Avoid_: feed (when referring to the active player's progress bar), scrubber

**Progress Marker**:
The player-native rendering of one Buddy's Progress Record on the Video Timeline — a small marker at that Buddy's last-known position, drawn in that Buddy's Buddy Color and tooltip-labelled with the Buddy and timestamp. It is a live watch position, distinct from a Note Dot (authored content). Styled to sit on YouTube's own progress bar, not in the apricot Note UI.
_Avoid_: Note Dot, pin, Note marker

**Progress Bar**:
The player-native fractional bar overlaid on a feed thumbnail showing how far a Buddy has watched that video, drawn in the Buddy Color — the thumbnail-surface counterpart to the Progress Marker (which sits on the active Video Timeline). Kept player-native, not part of the apricot Note UI: it mirrors the geometry of YouTube's own **Watched Bar** (inset, rounded, 4px), and where a tile shows both, the Progress Bar stacks directly above the Watched Bar rather than covering it. It is drawn inside the thumbnail's own box, so it never overhangs the image or floats in the gap beneath it.
_Avoid_: Video Timeline / YouTube's own progress bar (the active player's live scrubber — a different surface), thumbnail overlay

**Watched Bar**:
YouTube's own red resume-playback bar on a thumbnail — how far **you** watched that video, from YouTube's history, nothing to do with a Room. Never drawn or owned by the extension; it is only something the Progress Bar positions itself against (a tile may show both, the Progress Bar above). Distinct from the Progress Bar (a Buddy's position, in the Buddy Color).
_Avoid_: progress bar (alone), resume bar, red bar

**Note Dot**:
The small flat dot floating just above the Video Timeline at a Note's exact timestamp — a ~6px single-color circle (the author's Buddy Color; the viewer's own Notes white) with no border, outline, ring, or shadow, never displaced at rest: co-timed or near-timed Note Dots overlap into a **Dot Cluster** that fans apart only on hover (a display offset only — see Dot Cluster). It swallows the pointer events it receives, so hovering it never pops YouTube's storyboard thumbnail or time pill. The base timeline element from which a Note Preview (on hover) and an Expanded Note (on click) open. A locked Spoiler shows an obscured Note Dot; a Reaction and a text Note each show their own dot. An **Unseen** Note Dot pulses an apricot halo until Acknowledged; the dot itself never moves or resizes for the pulse. Distinct from a Progress Marker (a live watch position, not authored content, drawn on the bar itself).
_Avoid_: marker, Progress Marker, pin

**Dot Cluster**:
The group of Note Dots that overlap at rest because their timestamps land close together on the Video Timeline. At rest the members stay overlapping — the dots tell the truth about their moments — but hovering (or keyboard-focusing) anywhere on the Cluster fans its members apart evenly along the timeline with a smooth transform, so a dot that was completely covered becomes individually hoverable and can open its own Note Preview. The fan is a display offset only: the underlying dot positions never change, and the Cluster collapses back the instant the pointer leaves (a Cluster whose member has an open Expanded Note stays fanned so the anchor dot does not slide out from under the panel). Grouping is transitive — a chain of dots each overlapping the next is one Cluster even when the outer two do not touch — and a lone dot is a Cluster of one. Distinct from the Unseen pulse, which never moves or resizes a dot; the fan is a hover-time reachability affordance (it still applies under reduced motion, just snapping instead of animating).
_Avoid_: cluster dot (a single merged dot — rejected), count badge, grouped preview card

**Note Preview**:
The compact, hover-only summary shown above a Note on the Video Timeline. It unfolds out of the Note Dot on hover — scaling and fading up from the dot's own point rather than fading in from the card's centre — so the disclosure reads as one motion continuing into the Expanded Note. Content comes first with the author name beneath it (text body then author; Reaction emoji then author), the Note's video timestamp is pinned in the top-right corner, and it may summarize how many Replies the Note has. A transparent hover bridge keeps it alive so the pointer can travel from the dot onto the card to open the Expanded Note. It is not an interactive editing surface. A locked Spoiler's preview keeps the same layout as any Note — corner timestamp, author beneath — with the body slot reading a muted "Spoiler" placeholder and no Reply count.
_Avoid_: expanded mode, popup (ambiguous with the composer and playback notifications)

**Expanded Note**:
The pinned, interactive panel opened from ANY Note's dot or Note Preview — every Note kind expands. It grows out of the surface it was opened from — the hovered Note Preview's rectangle, or the dot's when no preview is on screen (keyboard activation) — so the panel appears to spring from the card the viewer clicked rather than popping in from nowhere. Its header pins the Note's video timestamp in the top-right corner, matching the Note Preview. A text Note's panel shows the full conversation and Note actions; a Reaction's panel shows the emoji and author, read-only; a locked Spoiler's panel masks the body with a muted "Spoiler" and withholds the conversation, delete, and Reply composer until unlocked. Opening the panel pauses the video at the viewer's current playhead position; it never seeks. Its universal action is **Go here**: an explicit control (labelled without a timestamp) that seeks playback to roughly one second before the Note's timestamp and resumes playing (then closes the panel), so the Note reveals through its own Playback Notification as playback reaches it. Go here is omitted when the paused playhead is already within ~2 seconds of the Note's timestamp — there is nowhere meaningful to go.
_Avoid_: hover state, Note Preview

**Reply**:
A text-only message appended to one parent Note and shown as part of that Note's conversation in the Expanded Note. Replies are limited to 100 characters, and one Note can have at most 10 Replies. Reactions are standalone timeline events and cannot have Replies.
_Avoid_: Note (a Reply has no independent timeline position), Reaction, generic comment

**Playback Notification**:
The transient presentation, anchored at the viewer's Notification Position, triggered whenever ordinary forward playback crosses a Note or Reaction timestamp. A text Note uses a clickable card that can open its Expanded Note; a Reaction uses a non-interactive animated emoji treatment. When one forward step crosses several at once, they are queued and enter one-per-beat on a ~100ms stagger, in timestamp order — a staggered entrance, not one-at-a-time serialization, so earlier notifications are still on screen as later ones arrive and each lives its own lifetime (a card ~4s, a burst ~2s) from its own entrance. They lay out along the Notification Position edge (see its main axis) and share that one container. Crossing a Note also Acknowledges it (see Acknowledge).
_Avoid_: Note Preview, Expanded Note, popup (ambiguous)

**Note Composer**:
The player-bound, pause-aware surface for authoring a Note at the current playhead moment — titled "Add a Note", it posts either a text Note or a Reaction (from the curated set), enforces the 100-char cap, and hands the posted server record straight to the Video Timeline. Opened from the "+" add-note control on the player; hosts the Mention Picker for @-mentions. It is an authoring surface, unlike the read-only Note Preview and the Expanded Note conversation panel.
_Avoid_: popup, editor, composer (alone, in docs), Note Preview, Expanded Note

**Arrival Toast**:
The transient corner notification shown when a new Buddy first appears in the Room (a fresh Progress Record or presence row). Purely informational and player-native. Distinct from a Playback Notification, which fires when playback crosses a Note or Reaction.
_Avoid_: Playback Notification, popup, alert

**Room Home Section**:
The compact panel the extension injects at the top of the YouTube **home page** (the recommendations grid on `youtube.com`), above the grid, which shifts down. It holds the Room Feed on the left and the Recommended for you list on the right, styled to match YouTube's home layout and kept deliberately short — small and scrollable, never a tall block. It is a distinct surface from the action popup and the Video Timeline (see ADR-0005). When Unpaired it shows a compact Create/Join prompt instead of the Feed + Recommendations. Its visibility is controlled by the Room Home Toggle; when the toggle is off the whole section is absent from the page. Its header carries a close control (an X at the right edge) which is simply a third way to turn that same toggle off, so closing the section is a hide, never a leave: no Room membership, Sharing state, or Recommendation is touched, and the guide's Room Home Toggle brings it back.
_Avoid_: home widget, dashboard, feed (alone)

**Room Home Toggle**:
An on/off control injected as a row into YouTube's own left guide (sidebar) on the home route, letting the viewer show or hide the entire Room Home Section. It is styled as a native guide entry — icon + "Buddy Room" label, pixel-matched to the sibling rows (Home, Shorts, Subscriptions) — with no separate switch: the buddies icon itself is the state indicator, tinted apricot while the section is shown and the native guide grey while hidden. Off removes the section completely (not merely collapsed); the toggle itself stays in the guide so it can be turned back on. The state persists per install in `chrome.storage.local` and is shared with the Room Home Section's header close control and the popup's Settings view — three surfaces, one preference, kept in sync live. Toggling only affects the Room Home Section — on-video markers, Notes, presence, and the watch-page recommend control keep running (the point is to hide the home surface without disabling the extension).
_Avoid_: sidebar widget, hide button, disable

**Recommendation**:
One video a member has recommended to the whole Room, replacing the old communal Shared Playlist (see ADR-0007). Stored exactly as before — one Room-level list keyed by videoId, up to 30 entries, each carrying its videoId, a title captured at recommend time, and the recommending member's Client ID (`addedBy`) plus a timestamp — but reinterpreted as directional. A member recommends "to all Buddies" with the Recommend Control; re-recommending an existing video is a no-op; the 31st distinct video is rejected. Only the recommender can **un-recommend** (a point delete that removes it for everyone), done from the watch-page recommend control since their own recommendations are hidden from their own grid.
_Avoid_: playlist item, playlist entry, shared playlist, queue, saved video

**Recommend Control**:
The control a member uses to add a Recommendation, in two placements that share one behavior and one vocabulary: the watch-page pill and the feed thumbnail's three-dots menu row, both reading "Recommend to Buddies" when idle. The pill's other states: "Recommended to you" on a video a Buddy recommended (nothing to toggle) and "Unrecommend" on the member's own — an action, not a state report (click to **un-recommend**). Adding recommends the video to the whole Room (see Recommendation). Recommend Control writes are NOT gated by Sharing.
_Avoid_: add-to-playlist button, Buddy Room button, "+ Buddy Room", "Add to Buddy Room" (legacy copy), save button

**Recommended for you**:
Each viewer's personalized view of the Room's Recommendations, rendered as a horizontal thumbnail row on the right of the Room Home Section: the Recommendations whose `addedBy` is **not** you, minus any you have Dismissed. Your own recommendations never appear here. Under each card the same "Watched by ..." attribution appears, derived live from the Room's Progress Records for that videoId — "watched" means "has a Progress Record" (started, not finished), disappearing when a member leaves or their record expires. Naming rule: "You" first (only when you personally have a record), then up to two Buddy Display Names, then "and N other(s)"; blank-name members use the "<Adjective> Buddy" fallback.
_Avoid_: my playlist, recommendations page, for you feed

**Dismiss**:
A recipient hiding one Recommendation from just their own Recommended-for-you grid. Dismissals are private and local — stored per install in `chrome.storage.local`, Room-scoped, mirroring Buddy Color storage — and never reach the backend, so they leave the Room-level Recommendation intact for every other member (contrast **un-recommend**, which is the recommender deleting the Recommendation for everyone). Keyed by videoId; there is no un-dismiss UI initially.
_Avoid_: remove, delete, un-recommend, hide (alone)

**Room Feed**:
The personalized, chronological, chat-like feed on the left of the Room Home Section. For the viewer it shows: Replies to Notes the viewer authored; Notes or Replies that Mention the viewer; deemphasized System Messages for recommendations (both received — "X recommended Title" — and the viewer's own — "You recommended Title to the Room"); and Watch Notices that a Buddy started watching a video the viewer recommended ("X started watching Title"). Link rule: only the message body (quoted) or the video title (unquoted) is a link. On a Note/Reply/Mention item the quoted message body links to the video **at your own place in it** — no timestamp seek, no auto-opened Expanded Note (ADR-0010): you arrive with the video paused and the Unseen Note Dot(s) pulsing on the Video Timeline, and you choose which to open. The pause is skipped when there is nothing to pulse (Notes Visibility off, or the Note is gone). The item also names the video it was left on ("on \"Title\"", plain text) when the Note carries a title. On a System Message or Watch Notice the video title links to the video. A **struck** System Message (superseded or un-recommended; see System Message) is the sole exception to the link rule: it renders no link at all, its title plain muted text. Items are grouped under day dividers (Today / Yesterday / date), oldest at the top and newest at the bottom, and windowed to the newest **20** items: a **Show more** control at the top of the scrollback (inline in the scroll content, above the topmost day divider) reveals the next 20 older items per click and disappears once the oldest item is rendered — item-level, so a partly revealed day keeps its divider and a day with no revealed items shows none. Like a chat, the Feed auto-scrolls to the newest item **only while the viewer is already at the bottom**; scrolled up, a rebuild preserves their exact position, and items a poll appends grow the window so visible rows never slide out of its top. The reveal window is transient view state (never persisted) and resets to 20 in exactly two cases: a new visit to the home route, and a Room Code change. There is **no** read/unread state _in the Feed_: it simply shows the most recent activity, and clicking a row never Acknowledges anything (see Unseen). It is derived entirely on the client from the Room read plus Playlist Events; nothing is stored per-recipient._Avoid_: inbox, notifications (as a stored entity), activity log

**Mention**:
An @-reference inside a Note or Reply that targets a specific Room member. Because Display Names are non-unique and cosmetic (identity is the Client ID), a Mention is resolved to and stored as the target's Client ID, never matched by name text (see ADR-0006). The author types "@", picks from a fuzzy-searchable roster of current Room members shown below the field, and the resulting Note/Reply carries a mentions list of Client IDs. A member is Mentioned when their Client ID appears in that list; the inline text still renders "@<Display Name>".
_Avoid_: tag, ping, at-name (as the stored form)

**Mention Picker**:
The @-mention autocomplete popover shown beneath the Note Composer or a Reply field — a fuzzy-searchable roster of current Room members. Picking one inserts "@<Display Name>" in the text and records the target's Client ID in the mentions list (see Mention, ADR-0006); it resolves identity by Client ID, never by name text.
_Avoid_: mention popup, tag menu, autocomplete (alone)

**Unseen**:
A Note or Reply addressed to you that you have not yet Acknowledged — exactly the set the Room Feed surfaces: a Reply to a Note you authored, or a Note or Reply that Mentions you. Never your own writes. A Reaction carries no Mentions and takes no Replies, so a Reaction is never Unseen; a locked Spoiler can be. Unseen state is anchored to the Video Timeline: a Note Dot is Unseen while the Note itself is an Unseen Mention **or** while any Reply beneath it is Unseen, and it then pulses (see Note Dot). It is private, per install, and Room-scoped — stored in `chrome.storage.local` keyed by Note/Reply id and pruned against each Room read, structurally identical to a Dismiss — so it never reaches the backend and never follows you to another browser (ADR-0010). It drives the Video Timeline only; the Room Feed has no read/unread state.
_Avoid_: unread, notification, badge, inbox

**Acknowledge**:
The viewer registering an Unseen Note or Reply, which stops its Note Dot pulsing for good. Three equivalent triggers, all on the Note Dot: hovering it (which opens its Note Preview), opening its Expanded Note, or ordinary forward playback crossing its timestamp (which fires its Playback Notification). Acknowledging a Note Dot clears **every** Unseen item anchored to it at once — the Mention and all Unseen Replies beneath it — even where the trigger revealed no body (a Note Preview shows a Reply count, not Reply text; a locked Spoiler stays masked). The pulse's job is to catch the eye, not to prove the message was read. Clicking a Room Feed row does not Acknowledge: that click exists to take you to the Note.
_Avoid_: read, mark as read, dismiss (a Dismiss hides a Recommendation)

**System Message**:
A small, deemphasized Room Feed line for a recommendation: recipients see "Bob recommended Title", and the recommender sees their own "You recommended Title to the Room". Live vs struck is a **per-Event** state, derived client-side: an `added` Playlist Event renders **struck through** when a newer `added` Event exists for the same videoId (it was superseded — the backend re-add is a no-op for an already-live videoId, so a second Event can only exist after a delete), or when its videoId is no longer in the Room's live Recommendation list (it is currently un-recommended). An un-recommend still produces no new Feed line and no Event. On a live line the title links to the video; a struck line carries **no link at all** — its title is plain muted text, the whole sentence is struck (the timestamp stays legible), and the row adds a "No longer recommended" tooltip plus a visually-hidden "(no longer recommended)" suffix for assistive technology. The title comes from the Playlist Event itself, so the message survives (struck) after the video is un-recommended; after recommend, un-recommend, re-recommend the Feed intentionally shows two lines for that video — the older struck, the newer live. Rendered visually quieter than personal Feed items.
_Avoid_: notification, alert, toast

**Watch Notice**:
A Room Feed line telling the recommender that a Buddy started watching a video they recommended ("Alice started watching Title"). Derived live on the client from the Room read — a Buddy's Progress Record for one of your Recommendations, timestamped by that record's `updatedAt` — and never stored, so it is best-effort: it may reorder as the Buddy keeps watching and cannot distinguish watched-before vs watched-after the recommendation. Shown only to the recommender.
_Avoid_: watched alert, view notification

**Playlist Event**:
The backend event-log record behind System Messages: one row per recommend (`{ type: 'added', videoId, title, actorClientId, at }`), aged out on the shared 14-day TTL and capped to the newest ~50, returned alongside the Room read. It carries the video `title` so the Feed line resolves even after the video is un-recommended. Un-recommends emit no Event. Distinct from a Recommendation (the current membership of the list) — an Event is the immutable history of a recommend.
_Avoid_: log entry, activity record

**Settings**:
The in-popup preferences view, opened from a gear control in the popup header and dismissed with a Back affordance. It holds all per-install customization (Theme Preference, Spoiler Default, Notification Position, Notes Visibility, Buddy Progress Visibility, and the Room Home Section's visibility) plus the relocated **Stop sharing** and **Leave room** actions. It is a distinct popup view from the Room Code views (chooser / join / connected), reusing the same mutually-exclusive view switching.
_Avoid_: options, preferences page, config panel

**Theme Preference**:
The viewer's chosen color theme — **Light**, **Dark**, or **Auto** (the default; stored as `system` for compatibility) — stored per install. Light/Dark force that theme on the action popup AND every in-page extension surface (the on-video Note UI and the Room Home Section) via an explicit theme marker on the document root (see ADR-0008). Auto follows the surroundings: in-page surfaces mirror YouTube's own theme (`html[dark]`, tracked live), while the popup — a separate document that cannot see the page — follows the OS via `prefers-color-scheme` (see ADR-0009). A single preference, so extension surfaces never disagree with an explicit choice.
_Avoid_: dark mode toggle, skin, appearance, system theme

**Spoiler Default**:
The per-install default state of the Add Note composer's Spoiler checkbox — on by default. It only seeds each opening's checkbox; the author can still flip it per Note, and Reactions are never Spoilers regardless.
_Avoid_: auto spoiler, spoiler mode

**Notification Position**:
The player edge where Playback Notifications appear, chosen from four edges — **top**, **bottom**, **left**, **right** — through a visual picker in Settings; the default is bottom. The chosen edge also drives the alerts' main axis: **top** and **bottom** lay concurrent notifications out as a centered horizontal row (Teams/Zoom reaction style) that wraps to another line — away from the edge — when the run outgrows the player, while **left** and **right** stack them as a vertically centered column. It affects only Playback Notifications — the Note Preview, Expanded Note, and Add Note composer stay anchored to their own dot or button.
_Avoid_: popup location, toast position, alert corner, zone, corner

**Notes Visibility** (aka "Notes off"):
A per-install switch that hides the ENTIRE on-video Note layer at once — every Video Timeline dot, Note Preview, Expanded Note, Playback Notification, AND the Add Note (+) button — leaving the player with zero YTB Note UI. Default is on (Notes shown). Independent of Sharing and of Buddy Progress Visibility.
_Avoid_: mute notes, hide comments, disable notes

**Buddy Progress Visibility**:
A per-install switch that hides Buddies' watch-position rendering on BOTH surfaces together — the position markers on the Video Timeline and the fractional bars on feed/home thumbnails. Default is on (progress shown). Independent of Notes Visibility; hiding progress never stops the popup roster or presence.
_Avoid_: hide markers (alone), hide buddies, hide bars
