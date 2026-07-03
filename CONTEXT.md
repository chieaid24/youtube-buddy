# YouTube Buddy

A Chrome extension plus Cloudflare Worker backend that lets a small Room of friends (up to five) passively share YouTube watch progress — each sees where the others left off, both on the active video's progress bar and on thumbnails.

## Language

**Room Code**:
A short shared string (e.g. `silly-otters`, shown as "The Silly Otters") that forms a Room. It is both the joining mechanism and the only access control — anyone holding the code can read and write that Room's data.
_Avoid_: friend code, group code, secret (the people form a _Room_, but the string itself is always the _Room Code_)

**Room**:
The set of people sharing one Room Code — at most five (you plus up to four Buddies). The backend enforces the cap best-effort; a sixth person is locked out.
_Avoid_: group, channel, party

**Progress Record**:
One user's last-known position in one specific video. A user has many Progress Records (one per video watched); old ones expire rather than living forever.
_Avoid_: progress entry, watch state, sync record

**Client ID**:
A random stable identifier generated once per browser installation. It is what identifies a user within a Room; two users can share a Display Name without colliding.
_Avoid_: user id, username

**Display Name**:
The human-readable label a user types for themselves (e.g. "aidan"), shown beside their markers. Purely cosmetic — carries no identity.
_Avoid_: name (alone, in code), handle

**Buddy** (pl. **Buddies**):
Any other person in your Room — there can be up to four. Their Progress Records get rendered in your browser using the Buddy Color that you assigned to them for that Room.
_Avoid_: friend, peer, partner (in code and UI copy; "friend" is fine in prose)

**Buddy Color**:
One of eight curated colors that a viewer assigns to a Buddy by clicking the color beside that Buddy's Display Name. Assignments are private to that browser and scoped to the Room Code. A color already assigned to another current Buddy in the same Room is unavailable; the same color may be used independently in another Room or browser.
_Avoid_: palette, global color, shared color

**Room states** (Unpaired / Waiting / In room / Room full):
Your membership in a Room, from your perspective. _Unpaired_ — no code. _Waiting_ — code set, but no Buddy has joined or recorded yet. _In room_ — at least one Buddy is present, via a presence row or a Progress Record (the popup lists each Buddy with their color swatch + last-seen). _Room full_ — five other Client IDs already exist under the code and you are not one of them, so you are the locked-out sixth: nothing renders.
_Avoid_: paired, connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. Pausing sharing never stops _seeing_ the Buddies' markers.
_Avoid_: broadcasting, syncing (which also covers reads)
