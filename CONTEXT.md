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
One of eight curated colors used to render a Buddy's progress for one viewer. A new Buddy receives a random currently available color. The viewer can change it by clicking the **Buddy Color Swatch** beside that Buddy's Display Name. Re-assigning a color repaints every surface that draws that Buddy — Progress Markers, thumbnail Watched-By Dots, Note Dots and Note Previews, an open Expanded Note's bylines, and Room Feed author names — immediately, in every open tab, without a reload or a navigation, the same live-follow way the Theme Preference applies (ADR-0008). Assignments are private to that browser and scoped to the Room Code. A color already assigned to another current Buddy in the same Room is unavailable; the same color may be used independently in another Room or browser. The assignment is discarded when the Buddy leaves, so a later rejoin receives a new random available color.
_Avoid_: palette, global color, shared color

**Room states** (Unpaired / Waiting / In room / Room full):
Your membership in a Room, from your perspective. _Unpaired_ - no code. _Waiting_ - code set, but no Buddy has joined or recorded yet. _In room_ - at least one Buddy is present, via a presence row or a Progress Record (the Settings view lists each Buddy with their color swatch and last-seen time). _Room full_ - five other Client IDs already exist under the code and you are not one of them, so you are the locked-out sixth: nothing renders.
_Avoid_: paired, connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. It gates **only** Progress Record reporting — Notes, Replies, Recommendations, and presence are all independent of it, so a member who has paused Sharing still reads AND writes Notes and Replies exactly as before (writing needs a Room, not Sharing). Pausing Sharing never stops _seeing_ the Buddies' markers, and never stops the member appearing in the Room via presence.
_Avoid_: broadcasting, syncing (which also covers reads)

**Connection Lost**:
The state a read surface enters after **two or more consecutive failed Room reads** (a network failure, or a non-2xx from the backend) - the extension cannot reach its backend. Orthogonal to the Room states, which describe membership: a Room may be _In room_ yet Connection Lost. While Connection Lost, every surface **retains its last successful render** (Progress Markers, the Settings roster, the Room Feed, and Recommendations all stay put, stale) rather than blanking, and the Extension Popup and Room Home Panel additionally show a quiet "Can't reach the backend - retrying..." line. The Video Timeline shows no extra indicator; its markers stay as last seen. The state clears when any Room read succeeds. It is driven only by **reads**: a failed background write stays silent and self-healing, while a failed explicit write shows inline feedback through the `network` error category.
_Avoid_: offline (ambiguous because it reads as the _user_ being offline), disconnected, error, down, backend unreachable

**Extension Popup**:
The compact, read-only popup Chrome opens from the extension toolbar icon. It reports the Room state, Room Code, Buddy count, Sharing state, and Connection Lost state, but it cannot edit any of them. Its only action is **Your Room**, which opens the Room Home Panel on the YouTube home route (ADR-0012). It reuses the active tab only when that tab is already on YouTube Home; otherwise it opens a new YouTube Home tab. All identity, Room, Buddy Color, and Settings changes live in the Room Home Panel.
_Avoid_: Control Panel, action popup, settings popup, dashboard

**Sharing Dot**:
The small read-only status indicator in the Extension Popup beside its Sharing status. It reports Sharing and never changes it. The **Share video progress** toggle in the Room Home Panel's Settings view owns the change and keeps the Stop-sharing confirmation. Sharing off never stops _seeing_ Buddies' markers.
_Avoid_: toggle, switch (the flip is the Share video progress toggle), status light

**Buddy Color Swatch**:
The small color control in the Room section of the Settings view, shown beside each Buddy's Display Name, that opens the eight-color picker to (re)assign that Buddy's Buddy Color for this Room (see Buddy Color). Private to one viewer and Room.
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

**Watched-By Dots**:
The small cluster of flat Buddy-colored dots overlaid in the top-left of a feed thumbnail's image box — one dot per Buddy who has a Progress Record for that video, ordered most-recent-first, the viewer excluded (YouTube's own red **Watched Bar** already tells the viewer's state). The dot itself is flat and carries no geometry: it means only "this Buddy has a record for this video" — how far they got is told in words by the tooltip's **Watch Status**, never by the dot's size, fill, or shape. The thumbnail-surface counterpart to the Progress Marker (which sits on the active Video Timeline and does carry a position). Hovering or keyboard-focusing the cluster shows a single dark tooltip listing one row per dot, in the same order: the Buddy's Buddy Color, their Display Name, and their Watch Status. Kept player-native, not part of the apricot Note UI. The dots are drawn inside the thumbnail's own box, never overhang the image, and exactly one cluster exists per video at a time: while YouTube's hover-autoplay inline preview covers the tile, the cluster is mirrored into the preview host (which owns it) and the tile's own is removed, so the dots stay visible and hoverable through the preview without ever rendering twice. Distinct from a **Note Dot** (authored content on the Video Timeline) and the timeline **Dot Cluster** (Note Dots fanning apart on hover). Replaced the retired thumbnail Progress Bar (a fractional per-Buddy band strip).
_Avoid_: Progress Bar (retired), Note Dot, watched badge, avatar stack

**Watch Status**:
How far one Buddy got through one video, in words, derived from their latest Progress Record (`timestamp / duration`) and shown as that Buddy's row in the Watched-By Dots tooltip. The fraction is rounded to the nearest 5% first, and that one rounded number decides the wording: at 80% or more it reads **"Watched"** (finished, near enough), otherwise it reads the rounded percent, floored at 5% so a Buddy who has a record never reads "0%". A Progress Record with no usable duration has no Watch Status and its row shows the name alone. Never a progress bar, a ring, or a partially-filled dot — the Watched-By Dot stays flat and the status stays text.
_Avoid_: progress, percent watched, completion, Watched Bar (that is YouTube's)

**Watched Bar**:
YouTube's own red resume-playback bar on a thumbnail — how far **you** watched that video, from YouTube's history, nothing to do with a Room. Never drawn or owned by the extension, and the reason Watched-By Dots exclude the viewer: your own state is already told here. Distinct from the Watched-By Dots (the Buddies' records, in the Buddy Colors, top-left).
_Avoid_: progress bar (alone), resume bar, red bar

**Note Dot**:
The small flat dot floating just above the Video Timeline at a Note's exact timestamp — a ~6px single-color circle (the author's Buddy Color; the viewer's own Notes white) with no border, outline, ring, or shadow, never displaced at rest: co-timed or near-timed Note Dots overlap into a **Dot Cluster** that fans apart only on hover (a display offset only — see Dot Cluster). It swallows the pointer events it receives, so hovering it never pops YouTube's storyboard thumbnail or time pill — but the activity it swallows is fed back to the player as a Controls Hold, so the timeline never fades out from under a hovering hand. Its hit target is deliberately larger than its glyph (a small circle is not a click target) and lives entirely in the Note Band, where it outranks YouTube's scrubber knob. The base timeline element from which a Note Preview (on hover) and an Expanded Note (on click) open. A locked Spoiler shows an obscured Note Dot; a Reaction and a text Note each show their own dot. An **Unseen** Note Dot pulses an apricot halo until Acknowledged; the dot itself never moves or resizes for the pulse. Distinct from a Progress Marker (a live watch position, not authored content, drawn on the bar itself).
_Avoid_: marker, Progress Marker, pin

**Dot Cluster**:
The group of Note Dots that overlap at rest because their timestamps land close together on the Video Timeline. At rest the members stay overlapping — the dots tell the truth about their moments — but hovering (or keyboard-focusing) anywhere on the Cluster fans its members apart evenly along the timeline with a smooth transform, so a dot that was completely covered becomes individually hoverable and can open its own Note Preview. The fan is a display offset only: the underlying dot positions never change, and the Cluster collapses back the instant the pointer leaves (a Cluster whose member has an open Expanded Note stays fanned so the anchor dot does not slide out from under the panel). Grouping is transitive — a chain of dots each overlapping the next is one Cluster even when the outer two do not touch — and a lone dot is a Cluster of one. Distinct from the Unseen pulse, which never moves or resizes a dot; the fan is a hover-time reachability affordance (it still applies under reduced motion, just snapping instead of animating).

A fan is a **minimum displacement**, never an even re-slotting: each member lands as close to its true moment as the Fan Gap allows, so a member with room to breathe does not move at all and true spacing survives wherever geometry permits. Consequently a fan can never push a dot onto another dot — separation is the constraint the fan is solved under, not a property of the group it happens to move — and a Cluster is exactly the set of dots that constraint chains together, never a merged dot.
_Avoid_: cluster dot (a single merged dot — rejected), count badge, grouped preview card, even slots / rank slots (spacing is solved, not assigned)

**Fan Gap**:
The minimum distance between two fanned Note Dot centers — the constraint a Dot Cluster's fan is solved under. It opens to its ideal where the timeline has room and shrinks toward a floor of one dot diameter where it does not (fanned dots may touch, never cover), so a roomy Cluster fans at full reach and a crowded one fans tighter, and the fan always stays on the bar. Because every dot on the Video Timeline is solved against this one constraint, the fan cannot collide with a dot outside the Cluster: a dot the fan would have reached is, by definition, chained into it — and it too moves only as far as it must.
_Avoid_: fan extent (the rendered width of the Cluster's hover-keeper, a different thing)

**Note Preview**:
The compact, hover-only summary shown above a Note on the Video Timeline. It unfolds out of the Note Dot on hover — scaling and fading up from the dot's own point rather than fading in from the card's centre — so the disclosure reads as one motion continuing into the Expanded Note. Content comes first with the author name beneath it (text body then author; Reaction emoji then author), the Note's video timestamp is pinned in the top-right corner, and it may summarize how many Replies the Note has. A transparent hover bridge keeps it alive so the pointer can travel from the dot onto the card to open the Expanded Note. It is not an interactive editing surface. A locked Spoiler's preview keeps the same layout as any Note — corner timestamp, author beneath — with the body slot reading a muted "Spoiler" placeholder and no Reply count.
_Avoid_: expanded mode, popup (ambiguous with the composer and playback notifications)

**Expanded Note**:
The pinned, interactive panel opened from ANY Note's dot or Note Preview — every Note kind expands. It grows out of the surface it was opened from — the hovered Note Preview's rectangle, or the dot's when no preview is on screen (keyboard activation) — so the panel appears to spring from the card the viewer clicked rather than popping in from nowhere. Its header pins the Note's video timestamp in the top-right corner, matching the Note Preview. A text Note's panel shows the full conversation and Note actions; a Reaction's panel shows the emoji and author, read-only; a locked Spoiler's panel masks the body with a muted "Spoiler" and withholds the conversation, delete, and Reply composer until unlocked. Opening the panel pauses the video at the viewer's current playhead position; it never seeks. Its universal action is **Go here**: an explicit control (labelled without a timestamp) that seeks playback to roughly one second before the Note's timestamp and resumes playing (then closes the panel), so the Note reveals through its own Playback Notification as playback reaches it. Go here is omitted when the paused playhead is already within ~2 seconds of the Note's timestamp — there is nowhere meaningful to go. Its prose is **selectable text**: the Note body, every Reply body, the author names, the "@" timestamp, and the relative times can all be highlighted and copied like ordinary page text. What is NOT authored prose is not selectable -- its buttons (so a double-click never selects a control's label), the masked "Spoiler" placeholder, and a Reaction's emoji glyph (its author name below it selects normally). A drag that starts inside the panel is a selection, never a Picture Click — see Press Origin.
_Avoid_: hover state, Note Preview

**Reply**:
A text-only message appended to one parent Note and shown as part of that Note's conversation in the Expanded Note. Replies are limited to 100 characters, and one Note can have at most 10 Replies. Reactions are standalone timeline events and cannot have Replies.
_Avoid_: Note (a Reply has no independent timeline position), Reaction, generic comment

**Playback Notification**:
The transient presentation, anchored at the viewer's Notification Position, with two triggers: ordinary forward playback crossing a Note or Reaction timestamp, and the viewer posting one from the Note Composer (see Post Echo). A text Note uses a clickable card that can open its Expanded Note; a Reaction uses a non-interactive animated emoji treatment. When one forward step crosses several at once, they are queued and enter one-per-beat on a ~100ms stagger, in timestamp order — a staggered entrance, not one-at-a-time serialization, so earlier notifications are still on screen as later ones arrive and each lives its own lifetime (a card ~4s, a burst ~2s) from its own entrance. Lifetime is set by the **trigger**, not by authorship: a crossing fires the full lifetime whoever wrote the Note, while a Post Echo lives half as long (a card ~2s, a burst ~1s). They lay out along the Notification Position edge (see its main axis) and share that one container. Crossing a Note also Acknowledges it (see Acknowledge).
_Avoid_: Note Preview, Expanded Note, popup (ambiguous)

**Post Echo**:
The Playback Notification the author fires for themselves the instant a Note or Reaction is posted from the Note Composer — the same card or burst a Buddy sees, in the same container at the same Notification Position, authored "You", but **short-lived: half a crossing's lifetime** (a card ~2s, a burst ~1s). It is a write receipt AND a preview of what the Room gets: the author sees exactly the presentation their Buddies will, only briefer — they already know what they wrote, so the receipt clears the player fast. It does not depend on playback, so it shows while the video is paused (the Note Composer pauses on open, so this is the common case). It fires once: the crossing window rebases to the new Note's timestamp, so resuming playback past that moment does not immediately repeat it — a later rewind-and-replay across the timestamp fires normally, like any other Note, at the FULL lifetime (the short life belongs to the echo trigger, not to your authorship). Replies have no Post Echo (the Expanded Note that sent one already shows it).
_Avoid_: toast, confirmation, self-notification, Buddy Arrival Toast

**Note Composer**:
The player-bound, pause-aware surface for authoring a Note at the current playhead moment — titled "Add a Note", it posts either a text Note or a Reaction (from the curated set), enforces the 100-char cap, and hands the posted server record straight to the Video Timeline. Opened from the "+" add-note control on the player; hosts the Mention Picker for @-mentions. It is an authoring surface, unlike the read-only Note Preview and the Expanded Note conversation panel.
_Avoid_: popup, editor, composer (alone, in docs), Note Preview, Expanded Note

**Video Picture**:
The rendered video surface inside the player -- the picture the viewer watches -- as distinct from the player's chrome: the control bar, the progress bar/scrubber, the settings/captions/chapter menus, the end-screen cards, and YTB's own on-video surfaces. A click on the Video Picture is a click on the video itself; a click on chrome is the viewer operating a control.
_Avoid_: player, video element, screen

**Pause Hold**:
The pause an on-video overlay (the Expanded Note or the Note Composer) takes when it opens over a PLAYING video, released when the overlay closes. A video that was already paused when the overlay opened is under no Pause Hold: closing the overlay leaves it paused. The Pause Hold is what makes an overlay a transient interruption -- closing it away from the video restores exactly the pre-open playback state.
_Avoid_: pause lease, auto-pause, freeze

**Controls Hold**:
The hold the Note layer takes on YouTube's player chrome so it cannot autohide while the viewer is engaged with a Note. YouTube fades its whole control bar -- the Video Timeline, and with it every Note Dot, Dot Cluster and Note Preview nested inside it -- after a few seconds of pointer inactivity ON THE PLAYER; because Note Dots swallow the pointer events they receive (so hovering one never pops YouTube's storyboard or time pill), that inactivity timer would otherwise expire under the viewer's own hovering hand and take the timeline away mid-read. Under a Controls Hold the extension instead keeps feeding YouTube's own timer, continuously, for as long as the hold lasts, so the chrome stays awake by YouTube's own rules. Surfaces take one only while a real pointer HOVER sits on them (the Note Dot family also on keyboard focus): a hovered or focused Note Dot, Dot Cluster or Note Preview; a hovered open Expanded Note; a hovered open Note Composer. The Expanded Note and Note Composer scope their hold to the hover alone -- NOT to their whole open lifetime, and NOT to keyboard focus: both auto-focus on open, so a focus-scoped hold would pin the chrome and make YouTube's timeline flicker (fade, then pop back on the next feed) the moment the pointer left the video. Releasing it hands the timer straight back -- the chrome fades on YouTube's normal schedule, never snapping away. Distinct from the Pause Hold (which holds PLAYBACK, not the chrome); an overlay commonly takes both.
_Avoid_: keep-alive, chrome lock, force-show, disable autohide

**Note Band**:
The strip of player pixels directly ABOVE the Video Timeline's top edge that the Note layer owns -- where every Note Dot, its (invisible, larger-than-the-glyph) hit target, a Dot Cluster's hover keeper, and a Note Preview's hover bridge live. The band is the whole of what the Note layer claims from the player: it never claims a pixel BELOW the bar's top edge, so the timeline itself stays seekable and scrubbable everywhere, directly under a Note Dot and at a Note's exact timestamp included. Inside the band the Note layer takes precedence over YouTube's own affordances that reach up into it -- the progress bar's grab pad, and the upper arc of the scrubber knob, which is far larger than a Note Dot and would otherwise swallow every click on a dot near the playhead. The knob stays grabbable on the bar itself, so scrubbing is never lost -- only its overlap into the band is conceded. A hit target is sized **per side**, never as one fixed box: each side reaches half the distance to its nearest neighbour on that side, less the dot's own radius, capped at a few pixels. So a lone dot gets its full reach both ways, a dot crowded on one side keeps its full reach on the other, and dots whose glyphs already overlap get no extra reach at all -- fanning the Dot Cluster is what makes those individually reachable. Neighbouring targets therefore touch but never overlap: every point in the band belongs to exactly one dot.
_Avoid_: hitbox, hover zone, dead zone, gutter

**Picture Click**:
A click on the Video Picture while an Expanded Note or Note Composer is open. It closes the overlay and ALWAYS plays -- whatever the video was doing before the overlay opened, and regardless of any Pause Hold. It is never a play/pause toggle: YouTube's native click-to-toggle never sees the click (YTB swallows it, ADR-0011), so a Picture Click cannot land the viewer back in a paused video. Clicking player chrome instead closes the overlay and leaves playback entirely to YouTube's control; clicking off the player altogether (comments, sidebar, page background) or pressing Escape closes it under Pause Hold semantics. A click whose Press Origin is the overlay itself is not a Picture Click at all -- it is the tail of a gesture the overlay owns (a text selection dragged past the panel's edge), and it changes neither the overlay nor playback.
_Avoid_: dismiss (reserved for hiding a Recommendation), outside click, toggle

**Press Origin**:
Where a click gesture STARTED -- the element under the pointer at press (`pointerdown`), as opposed to the element the resulting `click` event reports. The two differ whenever a press and its release land on different elements: the browser fires the click on their common ancestor, which for our on-video overlays is the player itself. So a text selection dragged from the Expanded Note out over the video reports a click on the Video Picture even though the viewer never clicked the picture. Click routing therefore keys on the Press Origin as well as the region (ADR-0011): a gesture that began inside an open overlay belongs to that overlay, whatever it ends on, and is routed as a no-op.
_Avoid_: click target, mousedown target

**Arrival Toast**:
The transient corner notification shown when a new Buddy first appears in the Room (a fresh Progress Record or presence row). Purely informational and player-native. Distinct from a Playback Notification, which fires when playback crosses a Note or Reaction.
_Avoid_: Playback Notification, popup, alert

**Room Home Panel** (formerly Room Home Section):
The complete in-page hub the extension overlays on YouTube Home: a fixed, left-docked portrait panel over a slightly dim scrim. Its normal view stacks the Room Feed above Recommendations. A gear replaces that content with the Settings view, and Back restores the normal view. Unpaired and Room full viewers open directly into Settings because they cannot use the Feed. Waiting and In room viewers open into the normal view. The panel is ephemeral: its close control, a scrim click, Escape, or an SPA navigation closes it, and reopening resets it to the state-appropriate initial view. Closing hides the panel and never leaves the Room or changes Sharing. The panel reads no YouTube layout DOM and never shifts the recommendations grid (ADR-0005).
_Avoid_: home widget, dashboard, feed (alone)

**Room Home Toggle**:
An on/off control injected as a row into YouTube's own left guide on the home route, letting the viewer open or close the Room Home Panel. It is styled as a native guide entry with a buddies icon and "Buddy Room" label. The icon is apricot while the panel is open and native guide grey while closed. The row persists nothing: it dispatches an open or close request and mirrors the panel's live state through an in-page CustomEvent. Toggling affects only the panel; on-video markers, Notes, presence, and the watch-page Recommend Control keep running.
_Avoid_: sidebar widget, hide button, disable

**Recommendation**:
One video a member has recommended to the whole Room, replacing the old communal Shared Playlist (see ADR-0007). Stored exactly as before — one Room-level list keyed by videoId, up to 30 entries, each carrying its videoId, a title captured at recommend time, the recommending member's Client ID (`addedBy`), a timestamp, and a server-minted `id` — but reinterpreted as directional. A member recommends "to all Buddies" with the Recommend Control; re-recommending an existing video is a no-op; the 31st distinct video is rejected. The `id` identifies this **recommendation instance**: a no-op re-add keeps it, but recommend -> un-recommend -> re-recommend mints a fresh one, which is how a re-recommended video escapes an earlier Dismiss (see Dismiss). **Un-recommend** is a point delete that removes it for everyone; the list is Room-communal, so the backend ownership-checks nothing, and it is only the UI that scopes the action — the "Unrecommend" pill appears on your own recommendations, done from the watch page since your own are hidden from your own grid.
_Avoid_: playlist item, playlist entry, shared playlist, queue, saved video

**Recommend Control**:
The control a member uses to add a Recommendation, in two placements that share one behavior and one vocabulary: the watch-page pill and the feed thumbnail's three-dots menu row, both reading "Recommend to Buddies" when idle. The pill's other states: "Recommended to you" on a video a Buddy recommended (nothing to toggle) and "Unrecommend" on the member's own — an action, not a state report (click to **un-recommend**). Adding recommends the video to the whole Room (see Recommendation). Recommend Control writes are NOT gated by Sharing. The pill is **optimistic**: a click flips it to its new state at once, with no in-between "Recommending..." or disabled state, and only a failure moves it — back to the true state, with the reason in a transient message (see Recommend Intent). On a member's own idle -> recommend click the pill also plays a brief celebratory "Recommended!" beat before settling into the resting "Unrecommend" (see Recommend Celebration).
_Avoid_: add-to-playlist button, Buddy Room button, "+ Buddy Room", "Add to Buddy Room" (legacy copy), save button

**Recommend Intent**:
A member's just-clicked, not-yet-confirmed Recommend or Un-recommend, held client-side per video for as long as the Room's own reads disagree with it. The intent overlays the Room read, so a Room read taken before the write landed cannot flip the pill back (the Recommendation itself is unchanged — this is purely how one viewer's control reads while the write is in flight). An intent is dropped when a Room read agrees with it, or when the write fails (the pill reverts). Its Recommend Control stays live throughout — no loading state — with a short click cooldown, and one write in flight per video: a member who toggles again mid-flight has their latest intent sent once the outstanding write settles.
_Avoid_: pending state, optimistic flag, loading state, dirty state

**Recommend Celebration**:
The brief confirmation the watch-page pill plays on a member's own idle -> recommend click: the label swaps to "Recommended!" with a one-shot apricot confetti burst, then settles into the resting "Unrecommend" after about 1.2s. It is purely cosmetic and fires only on that local click gesture -- never on a Room read reconciling state, a cross-tab change, or page load -- so it never contradicts the optimistic model: the pill still flips at once (see Recommend Intent), and a failed write still reverts to idle with the transient feedback message. Only this surface and this direction celebrate; un-recommend (mine -> idle) and the thumbnail three-dots menu row stay plain. Honors prefers-reduced-motion by skipping the burst while still swapping the label. The confetti nodes are non-interactive (pointer-events: none) and self-clean, so they never block a click on the player or the pill.
_Avoid_: toast, success modal, loading state, confirmation dialog

**Recommended for you**:
Each viewer's personalized view of the Room's Recommendations, rendered as a thumbnail row in the lower region of the Room Home Panel, below the Room Feed: the Recommendations whose `addedBy` is **not** you, minus any you have Dismissed. Your own recommendations never appear here. Under each card the same "Watched by ..." attribution appears, derived live from the Room's Progress Records for that videoId — "watched" means "has a Progress Record" (started, not finished), disappearing when a member leaves or their record expires. Naming rule: "You" first (only when you personally have a record), then up to two Buddy Display Names, then "and N other(s)"; blank-name members use the "<Adjective> Buddy" fallback.
_Avoid_: my playlist, recommendations page, for you feed

**Dismiss**:
A recipient hiding one Recommendation from just their own Recommended-for-you grid. Dismissals are private and local — stored per install in `chrome.storage.local`, Room-scoped, mirroring Buddy Color storage — and never reach the backend, so they leave the Room-level Recommendation intact for every other member (contrast **un-recommend**, which deletes the Recommendation for everyone). Keyed by the Recommendation's `id` — the recommendation instance, not the video — so a Dismiss silences exactly the recommendation it was aimed at: a Buddy who un-recommends and then recommends the same video again mints a new id, and the card comes back. Dismissed ids are pruned against a successful Room read only (a failed read never drops them); there is no un-dismiss UI initially.
_Avoid_: remove, delete, un-recommend, hide (alone)

**Room Feed**:
The chronological, chat-like feed in the upper region of the Room Home Panel, above the Recommended for you row. It shows every text Note and Reply in the Room - the viewer's own included, authored as "You" ("You left a note", "You replied") - plus deemphasized System Messages for recommendations (both received — "X recommended Title" — and the viewer's own — "You recommended Title to the Room") and Watch Notices that a Buddy started watching a video the viewer recommended ("X started watching Title"). Reactions never appear in the Feed. Items addressed to the viewer - a Reply to a Note the viewer authored ("X replied to your note") or a Note or Reply that Mentions the viewer ("X mentioned you") - render **emphasized** (an accent-tinted, accent-edged row with accented action copy); every other Note or Reply is a plain "X left a note" / "X replied" line. A Spoiler Note's Feed row masks its body (a muted "Spoiler", like a locked Note Preview) while still linking to the video. Link rule: only the message body (quoted) or the video title (unquoted) is a link. On a Note/Reply/Mention item the quoted message body links to the video **at your own place in it** — no timestamp seek, no auto-opened Expanded Note (ADR-0010): you arrive with the video paused and the Unseen Note Dot(s) pulsing on the Video Timeline, and you choose which to open. The pause is skipped when there is nothing to pulse (Notes Visibility off, or the Note is gone). The item also names the video it was left on ("on \"Title\"", plain text) when the Note carries a title. On a System Message or Watch Notice the video title links to the video. A **struck** System Message (superseded or un-recommended; see System Message) is the sole exception to the link rule: it renders no link at all, its title plain muted text. Items are grouped under day dividers (Today / Yesterday / date), oldest at the top and newest at the bottom, and windowed to the newest **20** items: a **Show more** control at the top of the scrollback (inline in the scroll content, above the topmost day divider) reveals the next 20 older items per click and disappears once the oldest item is rendered — item-level, so a partly revealed day keeps its divider and a day with no revealed items shows none. Like a chat, the Feed auto-scrolls to the newest item **only while the viewer is already at the bottom**; scrolled up, a rebuild preserves their exact position, and items a poll appends grow the window so visible rows never slide out of its top. The reveal window is transient view state (never persisted) and resets to 20 in exactly two cases: a new visit to the home route, and a Room Code change. There is **no** read/unread state _in the Feed_: it simply shows the most recent activity, and clicking a row never Acknowledges anything (see Unseen). It is derived entirely on the client from the Room read plus Playlist Events; nothing is stored per-recipient.
Every Feed link previews its destination on hover through a **Video Hover Card**, never a native browser tooltip.
_Avoid_: inbox, notifications (as a stored entity), activity log

**Video Hover Card**:
The small floating preview that appears while a pointer hovers (or a keyboard focuses) any Room Feed link -- a Note/Reply body, a System Message title, a Watch Notice title: the destination video's thumbnail above its title. It replaces the browser's native `title=` tooltip on those links entirely, so the Feed never shows one. Cursor-following: it tracks pointer movement, sits below-right of the cursor, and flips to the opposite side rather than overflow the viewport; keyboard focus anchors it under the link instead. Purely decorative to assistive technology (`aria-hidden`) -- the link keeps a visually-hidden "Watch \"Title\"" suffix for that, which is also where the "Watch this video" fallback lives when the record captured no title. Non-interactive (`pointer-events: none`), so it can never intercept the hover that spawned it or a click through it, and it hides on Feed scroll, on a Feed rebuild, and with the panel. One card exists at a time, owned by the overlay root. A missing thumbnail leaves the title alone rather than a broken image box.
_Avoid_: tooltip, popover, preview player, hover autoplay

**Mention**:
An @-reference inside a Note or Reply that targets a specific Room member. Because Display Names are non-unique and cosmetic (identity is the Client ID), a Mention is resolved to and stored as the target's Client ID, never matched by name text (see ADR-0006). The author types "@", picks from a fuzzy-searchable roster of current Room members shown below the field, and the resulting Note/Reply carries a mentions list of Client IDs. A member is Mentioned when their Client ID appears in that list; the inline text still renders "@<Display Name>".
_Avoid_: tag, ping, at-name (as the stored form)

**Mention Picker**:
The @-mention autocomplete popover shown beneath the Note Composer or a Reply field — a fuzzy-searchable roster of current Room members. Picking one inserts "@<Display Name>" in the text and records the target's Client ID in the mentions list (see Mention, ADR-0006); it resolves identity by Client ID, never by name text.
_Avoid_: mention popup, tag menu, autocomplete (alone)

**Unseen**:
A Note or Reply addressed to you that you have not yet Acknowledged — exactly the set the Room Feed emphasizes: a Reply to a Note you authored, or a Note or Reply that Mentions you. Never your own writes. A Reaction carries no Mentions and takes no Replies, so a Reaction is never Unseen; a locked Spoiler can be. Unseen state is anchored to the Video Timeline: a Note Dot is Unseen while the Note itself is an Unseen Mention **or** while any Reply beneath it is Unseen, and it then pulses (see Note Dot). It is private, per install, and Room-scoped — stored in `chrome.storage.local` keyed by Note/Reply id and pruned against each Room read, structurally identical to a Dismiss — so it never reaches the backend and never follows you to another browser (ADR-0010). It drives the Video Timeline only; the Room Feed has no read/unread state.
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

**Settings view**:
The one-scroll management view opened by the gear in the Room Home Panel header. It replaces the normal Room Feed and Recommendations content until Back is pressed. Its four visible sections are **Profile** (Nickname), **Room** (Room state, Room Code, Create or Join, Buddy roster, Buddy Color Swatches, and Leave Room), **On-video** (Share video progress, Notes Visibility, Buddy Progress Visibility, Spoiler Default, and Notification Position), and **Appearance** (Theme Preference). Stop sharing and Leave Room keep confirmation dialogs; Escape dismisses the confirmation before it can close the panel. Unpaired and Room full viewers open directly into this view.
_Avoid_: Control Panel, options page, preferences page, config panel

**Theme Preference**:
The viewer's chosen color theme - **Light**, **Dark**, or **Auto** (the default; stored as `system` for compatibility) - stored per install. Light or Dark forces that theme on the Extension Popup and every in-page extension surface through an explicit theme marker on the document root (ADR-0008). Auto follows the surroundings: in-page surfaces mirror YouTube's theme, while the Extension Popup follows the operating system because it cannot see the page (ADR-0009).
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
A per-install switch that hides Buddies' watch-position rendering on BOTH surfaces together — the Progress Markers on the Video Timeline and the Watched-By Dots on feed/home thumbnails (the fractional thumbnail Progress Bar it used to hide is retired). Default is on (progress shown). Independent of Notes Visibility; hiding progress never stops the popup roster or presence.
_Avoid_: hide markers (alone), hide buddies, hide bars
