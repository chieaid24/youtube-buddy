# Room Code generation checks for collisions; check failures block creation

The Create flow generates a candidate `<descriptor>-<plural-animal>` slug (`extension/room-code.js`) and, before committing to it, calls the existing `GET /?code=X` to see whether that code already has any Progress Records or presence rows. An empty result means the code is free; any row means it's taken and a fresh candidate is generated, up to 3 attempts. This reuses the read path that already exists for showing a Room's members — no new backend endpoint, no schema change, no contract change to `GET`.

This differs from ADR-0002's stance on the membership cap, and deliberately so. ADR-0002 accepts that KV's eventual consistency can transiently let a Room exceed five members, because the cost of that race is a temporary Room that's slightly bigger than intended — annoying, self-correcting, cheap. A Room Code collision is a different kind of failure: two unrelated groups of friends would end up sharing one Room by accident, each seeing the other's watch history, with the Room Code being the _only_ access control the product has (per CONTEXT.md). That's a privacy leak between strangers, not a capacity glitch, so this path trades a little more caution for a lot less risk:

- If all 3 generate-and-check attempts come back taken, the 3rd candidate gets a random 3-digit numeric suffix (`red-frogs-742`) appended without a further check, rather than looping forever or surfacing a dead end to the user. At 2420 word-pairs x 900 suffix values, the combined space is large enough that this fallback is effectively collision-free even though it isn't verified.
- If the existence check itself fails (network error, backend unreachable) rather than returning a clean taken/free answer, code generation aborts and the popup shows an error instead of silently proceeding on an unconfirmed code. An unconfirmed code is treated as unsafe, not as available.
- The retry loop itself (attempts 1-3) is invisible to the user — no spinner, no visible state change — since from their perspective Create either works or shows an error; the internal collision-checking is not a detail worth surfacing.

## Consequences

- Create now costs up to 3 extra `GET /?code=X` round-trips before the existing presence assert, versus the previous single generate-and-commit. At friends-scale this is negligible and happens before anything is written.
- A rare fallback code (`word-word-NNN`) breaks the pure two-word aesthetic described in CONTEXT.md's Room Code entry; this is accepted as a last-resort path, not the common case.
- Join is unaffected: typed codes stay permissive and are never checked for collision, since joining an existing Room is the point.
- If the reuse-existing-GET approach ever needs to change (e.g. a dedicated existence endpoint to avoid shipping full payloads), the collision logic is isolated in one place (`extension/room-code.js`) and can be swapped without touching the retry/fallback contract.
