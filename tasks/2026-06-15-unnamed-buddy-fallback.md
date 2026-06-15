# Task: Make Display Name truly optional — unnamed Buddies render a stable "Adjective Buddy"

## Problem

- The popup treats Display Name as **cosmetic**, but the backend makes it **mandatory**: `validate()` (`backend/src/index.ts:100`) rejects `name === ""` with `400 "missing or invalid field: name"`. The reporter swallows failed POSTs (`reporter.js:78`), so an unnamed user **silently never shares and never appears to others** — not even as "Buddy".
- `Buddy "Buddy" McGee` (`popup.html:344`) is **placeholder ghost text** — never submitted. The bug-report wording is a red herring; the real cause is the 400 above.
- The render fallbacks (`renderer.js:144,226`, `popup.js:388` → `"Buddy"`; `popup.js:298` → `"your Buddy"`) are **dead code** for empty names (empty names never reach storage) and inconsistent with each other.

## Desired behavior

Leaving Display Name blank is allowed and you still share. Others see a **stable, playful** `"<Adjective> Buddy"` derived from your `clientId` (same adjective everywhere, every render, for every viewer) — same pattern as the existing `buddyColor` hash.

## Changes (scope: `extension/` + `backend/` only — `share/extension/` stays frozen)

### 1. `backend/src/index.ts` — make `name` optional

Drop `name` from the nonempty-required loop (keep `clientId`, `videoId` required + nonempty). Coerce missing/empty → `""` on store (`name: body.name ?? ""`). Update `backend/test/index.spec.ts`: empty/missing name now `200` (was `400`) + add a test case.

### 2. `extension/shared.js` — add `ADJECTIVES` + `buddyName(clientId, name)` helper

Place beside `BUDDY_PALETTE`/`buddyColor`. Returns `name.trim()` if non-empty, else `` `${ADJECTIVES[hash(clientId) % 16]} Buddy` ``, reusing `buddyColor`'s char-hash style.

Curated list (16 entries):

```
Silly, Scary, Sleepy, Sneaky, Grumpy, Goofy, Wild, Brave,
Cheeky, Jolly, Mighty, Sloppy, Spooky, Zesty, Snazzy, Wobbly
```

### 3. Wire the helper at all foreign-name render sites

Replace inline `record.name ? record.name : "Buddy"` with `YTB.buddyName(record.clientId, record.name)`:

- `renderer.js:144` — marker tooltip
- `renderer.js:226` — thumbnail segment tooltip
- `popup.js:388` — roster row
- `popup.js:298` — disconnect-confirm (unnamed now reads e.g. "Silly Buddy" instead of "your Buddy")

## Design decisions

| Decision | Rationale |
|----------|-----------|
| Backend accepts empty name (coerces to `""`) | Matches popup's "cosmetic" intent; unblocks sharing for unnamed users |
| Adjective hashed from `clientId`, not random | Stability — same friend always shows same adjective, all viewers, all surfaces |
| 16 adjectives, mod-length hash | `gcd(16,5)=1` → adjective independent of color (5-color palette); decent spread vs ≤4 Buddies on screen |
| Joke placeholder stays | Correct ghost-text behavior, never leaks to backend or other users |
| Self never shows as "Adjective Buddy" | Fallback applies only to foreign records; own popup name field stays blank + placeholder |
| Disconnect-confirm uses helper too | One consistent token instead of mixed "Buddy" / "your Buddy" |
| `share/extension/` untouched | Intentionally frozen; once backend accepts empty names, share/ build starts sharing unnamed users too but shows old plain "Buddy" fallback until re-frozen |

## Verification

- [ ] `npm test` green (updated empty-name test in backend)
- [ ] Manual: two clients, one blank name, Sharing on → blank client's POST returns `200`
- [ ] Other client sees stable `"<Adjective> Buddy"` on marker tooltip, thumbnail-segment tooltip, and popup roster
- [ ] Adjective identical across surfaces and across renders; color + adjective both stable per Buddy
- [ ] Named Buddy still shows their real name (regression check)
