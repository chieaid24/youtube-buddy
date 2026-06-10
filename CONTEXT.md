# YouTube Buddy

A Chrome extension plus Cloudflare Worker backend that lets a small Group of friends (up to five) passively share YouTube watch progress — each sees where the others left off, both on the active video's progress bar and on thumbnails.

## Language

**Friend Code**:
A short shared string (e.g. `jumping-silly-deer`) that forms a Group. It is both the joining mechanism and the only access control — anyone holding the code can read and write that Group's data.
_Avoid_: room code, group code, secret (the people form a *Group*, but the string itself is always the *Friend Code*)

**Group**:
The set of people sharing one Friend Code — at most five (you plus up to four Buddies). The backend enforces the cap best-effort; a sixth person is locked out.
_Avoid_: room, channel, party

**Progress Record**:
One user's last-known position in one specific video. A user has many Progress Records (one per video watched); old ones expire rather than living forever.
_Avoid_: progress entry, watch state, sync record

**Client ID**:
A random stable identifier generated once per browser installation. It is what identifies a user within a Group; two users can share a Display Name without colliding.
_Avoid_: user id, username

**Display Name**:
The human-readable label a user types for themselves (e.g. "aidan"), shown beside their markers. Purely cosmetic — carries no identity.
_Avoid_: name (alone, in code), handle

**Buddy** (pl. **Buddies**):
Any other person in your Group — there can be up to four. Their Progress Records get rendered in your browser, each in a stable per-Buddy color (so the same friend is the same color everywhere).
_Avoid_: friend, peer, partner (in code and UI copy; "friend" is fine in prose)

**Group states** (Unpaired / Waiting / In group / Group full):
Your membership in a Group, from your perspective. *Unpaired* — no code. *Waiting* — code set, but no Buddy has a record yet. *In group* — at least one Buddy's record exists (the popup lists each Buddy with their color swatch + last-seen). *Group full* — five other Client IDs already exist under the code and you are not one of them, so you are the locked-out sixth: nothing renders.
_Avoid_: paired, connected, linked

**Sharing**:
Whether this installation currently reports its own Progress Records. Pausing sharing never stops *seeing* the Buddies' markers.
_Avoid_: broadcasting, syncing (which also covers reads)
