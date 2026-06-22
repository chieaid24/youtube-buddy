# Cute Friend Codes + Copy Button (replace reroll)

> Status: **DONE** 2026-06-21. 2-word codes (`adjective-animal`, plural), `<span>` pretty label, inline copy button with check-swap; reroll deleted; tolerant `normalizeCode`.

## Summary

Rewrite the Friend Code system: new 2-word cute codes (`adj-animal` plural), pretty display ("The Silly Otters"), inline copy button replaces reroll.

## Decisions

| Branch | Decision |
|--------|----------|
| What gets funnier | Code word lists (not Display Name) |
| Code shape | `adjective-animal` (2 words, plural animal) |
| Code identity | Display label over slug — slug = `silly-otters`, display = "The Silly Otters" |
| Copy target | Copy copies pretty form; join accepts both pretty + slug (tolerant normalize) |
| Plurals | Store animals as plurals in word list — no runtime pluralization |
| Word list size | ~120 adj × ~120 animals ≈ 14k+ combos |
| Copy visibility | Shows for both created + joined codes (always in Connected view) |
| Regen trigger | Delete reroll entirely; new code = Change code → Create a code |
| Copy UX | Clipboard SVG → checkmark SVG on click, reverts after 1.5s |
| SVG source | Inline in popup.html |
| Code display element | Replace readonly `<input>` with styled `<span>` |
| Slug form | Keeps plural (`silly-otters`), no singularization |

## Implementation scope

### popup.js

1. Delete `CODE_VERBS`. Rewrite `CODE_ADJECTIVES` (~120 cute/funny words). Rewrite `CODE_ANIMALS` (~120 cute plurals).
2. `generateCode()` → pick 1 adj + 1 animal, join with hyphen (slug form).
3. New `prettyCode(slug)` → "The Silly Otters" (title-case, prepend "The ").
4. Delete reroll event listener + `el.reroll` reference.
5. Add copy button logic: `navigator.clipboard.writeText(prettyCode(code))`, SVG swap → check → revert 1.5s.

### popup.html

6. Replace `<input id="code" readonly>` with `<span id="code">`.
7. Replace `<button id="reroll">` with `<button id="copy-code">` containing inline clipboard SVG (+ hidden checkmark SVG for swap).
8. Remove `reroll` from `el` object.

### shared.js

9. `normalizeCode(raw)` upgraded: trim → lowercase → strip leading "the " → replace spaces with hyphens → collapse multiple hyphens. Result: whether buddy types "The Silly Otters" or "silly-otters", both → `silly-otters`.

### No backend changes

Codes are still opaque strings in KV keys.

## Acceptance criteria

- [x] Generated codes display as "The {Adj} {Animals}" in popup — `el.code.textContent = prettyCode(code)`
- [x] Copy button copies pretty form to clipboard — `navigator.clipboard.writeText(prettyCode(code))`
- [x] Copy icon swaps to checkmark, reverts after 1.5s — `.copied` class toggle, `setTimeout(…, 1500)`
- [x] Buddy can join by pasting "The Silly Otters" OR typing "silly-otters" — verified: both normalize to `silly-otters` (round-trip test passed)
- [x] No reroll button anywhere — `#reroll` markup + `el.reroll` + listener all removed
- [x] Change code → Create a code mints fresh code — `createAndCommit`/`generateCode` preserved
- [x] Copy button visible for both created and joined codes — always rendered in Connected view (no origin gate)
- [x] Word lists 120×120, all cute/funny, animals pre-pluralized — verified unique, no dups
- [x] Existing tests still pass — backend untouched (16 green)

## Review

- `extension/popup.js` — deleted `CODE_VERBS`; rewrote `CODE_ADJECTIVES`/`CODE_ANIMALS` (120 each, animals plural); `generateCode()` → `adjective-animal`; added `prettyCode(slug)`; replaced reroll listener with copy-button logic; `el.reroll`→`el.copyCode`; `showConnected`/`clearCodeAndChoose` use `el.code.textContent`.
- `extension/popup.html` — `<input id="code" readonly>` → `<span id="code">`; `<button id="reroll">` → `<button id="copy-code">` with inline clipboard + check SVGs; CSS for the span label + copy-button swap.
- `extension/shared.js` — `normalizeCode` now strips leading "the ", maps whitespace→hyphens, collapses/trims hyphens (tolerant of pretty + slug forms).
- Verified: `node --check` clean; no stale refs; 120/120 unique lists; normalize/pretty round-trip passes.
- Note: kept "Friend Code" terminology — the room-rename is the last task in this batch.
