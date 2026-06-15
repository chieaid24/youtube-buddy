# Cute Friend Codes + Copy Button (replace reroll)

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

- [ ] Generated codes display as "The {Adj} {Animals}" in popup
- [ ] Copy button copies pretty form to clipboard
- [ ] Copy icon swaps to checkmark, reverts after 1.5s
- [ ] Buddy can join by pasting "The Silly Otters" OR typing "silly-otters"
- [ ] No reroll button anywhere
- [ ] Change code → Create a code mints fresh code (existing behavior preserved)
- [ ] Copy button visible for both created and joined codes
- [ ] Word lists ~120×120, all cute/funny, animals pre-pluralized
- [ ] Existing tests still pass (backend unchanged)
