# YouTube Buddy

A Chrome extension plus Cloudflare Worker backend that lets two friends passively share YouTube watch progress — each sees where the other left off, both on the active video's progress bar and on thumbnails.

## Language

**Friend Code**:
A short shared string (e.g. `run-silly-fox`) that pairs two users. It is both the pairing mechanism and the only access control — anyone holding the code can read and write that pair's data.
_Avoid_: room code, group code, secret

**Progress Record**:
One user's last-known position in one specific video. A user has many Progress Records (one per video watched); old ones expire rather than living forever.
_Avoid_: progress entry, watch state, sync record

**Client ID**:
A random stable identifier generated once per browser installation. It is what identifies a user within a Friend Code; two users can share a Display Name without colliding.
_Avoid_: user id, username

**Display Name**:
The human-readable label a user types for themselves (e.g. "aidan"), shown beside their markers. Purely cosmetic — carries no identity.
_Avoid_: name (alone, in code), handle

**Buddy**:
The other person in a pairing — the one whose Progress Records get rendered in your browser.
_Avoid_: friend, peer, partner (in code and UI copy; "friend" is fine in prose)

**Paired**:
The state where a Progress Record from another Client ID exists under your Friend Code. Before that, a user with a code is *Waiting*; with no code, *Unpaired*.
_Avoid_: connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. Pausing sharing never stops *seeing* the Buddy's markers.
_Avoid_: broadcasting, syncing (which also covers reads)
