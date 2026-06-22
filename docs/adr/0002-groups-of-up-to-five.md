# Rooms of up to five; best-effort membership cap

A Room Code is one **Room** of up to five distinct Client IDs (you plus up to four Buddies), not a strict pair. The data model already tolerated more than two members — the KV key scheme is `${code}:${clientId}:${videoId}` for Progress Records (plus `${code}:presence:${clientId}` for presence) and GET returns everyone under the code — so the change is mostly cap enforcement and rendering, not storage.

The cap is enforced **best-effort on POST**: the handler lists the `${code}:` prefix, derives the distinct Client IDs from the key names (no value reads — a presence key contributes its trailing Client ID, a progress key its leading one), and rejects a brand-new Client ID with `409` once five already exist. Both kinds of row reserve a slot, so a member who has only joined (presence, no watch data) still counts. Returning members — and their new videos — always go through. Reads (GET) are never capped.

We deliberately did **not** route membership through a Durable Object. KV is eventually consistent with no transactions, so two people joining a four-member Room at the exact same moment can both see four and both be admitted, momentarily reaching six; likewise a Room whose key listing exceeds the page size could undercount. A Durable Object keyed by code would serialize joins and remove the race, but it adds a new Cloudflare primitive, a binding, and a migration to a Worker whose whole value is being one file over one KV namespace. For a friends-only tool whose only access control is a shared weak secret, an occasional sixth member is a far smaller cost than that complexity. The locked-out sixth is treated as fully out: the popup shows *Room full* and the renderer draws nothing (reads are not used to grant a read-only view).

## Consequences

- POST now does a `list` before its `put` (previously a bare `put`). At friends-scale this is negligible; it is the price of the cap living in KV rather than a Durable Object.
- The cap can be exceeded transiently under a simultaneous-join race or a very large (>1000-key) Room; this is accepted, not a bug. The client tolerates a Buddy list longer than four.
- The extension assumes multiple Buddies: stable per-Buddy colors (`YTB.buddyColor`), one marker per Buddy on the watch bar, a segmented progress bar on thumbnails, and a Buddy roster in the popup. `YTB.roomView` centralizes the membership/locked computation shared by the renderer and popup, merging Progress Records and presence rows into one Buddy set.
- Existing two-person pairs keep working unchanged — two is within five, and no migration is required.
- If strict membership is ever needed (e.g. paid Rooms, abuse pressure), introduce a Durable Object for the join/cap path only; POSTing progress and GETting records can stay on KV.
