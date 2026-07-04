# Note deletion requires a clientId ownership check

Every other write in this app trusts the caller completely: the Room Code is the only access control, and `DELETE /member` lets anyone holding the code remove any member's presence and Progress Records, no ownership check. Deleting a Note breaks that pattern: `DELETE /notes` requires the requester's `clientId` to match the Note's stored author `clientId`, returning 403 otherwise.

The difference is what's being deleted. Progress Records and presence rows are ephemeral, machine-written state that gets regenerated the next time you watch or open a tab — an errant deletion by a misbehaving Buddy's client is a non-event. A Note is authored content a specific person chose to write; letting anyone in the Room silently delete anyone else's Notes turns a small annoyance (mis-set spoiler flag) into content loss with no recovery. The MVP's "author can delete, no edit" lifecycle decision (see the Notes PRD) only makes sense if delete is actually scoped to the author.

## Consequences

- `POST /notes` responses (and the stored KV value) must carry `clientId` so `DELETE /notes` has something to check against — already true, since every Note record needs an author.
- This is the app's first per-request authorization check beyond "do you know the Room Code." Future Note-adjacent endpoints should default to asking the same question (is this destructive and irreversible to someone other than the actor?) rather than assuming the existing trust-the-client precedent always applies.
- Still no real authentication — a malicious client can lie about its own `clientId` and delete its own Notes it didn't write, or claim any `clientId` it has observed in a GET response and delete that identity's Notes. The check stops accidental cross-Buddy deletes from a correctly-behaving client, not a hostile one. Acceptable for a friends-only tool with no stronger identity primitive available.
