# Task: Display Name — drop the "Save" button, save on blur, pencil-icon Edit

> Status: defined (grilled), not started. Created 2026-06-14.

## Problem

The Display Name field carries a redundant **"Save"** button. The name already
persists to `chrome.storage.local` on **every keystroke** (`popup.js:124` —
`input` listener calls `YTB.setConfig`), and `commitName()` already runs on
**blur** (`popup.js:134`) and **Enter** (`popup.js:131`). The Save button only
adds a third commit trigger plus a blur-skip guard
(`if (e.relatedTarget === el.nameSave) return;`, `popup.js:135`). It is clutter.

Separately, the locked state's edit affordance is a text **"Edit"** button sitting
*beside* the name chip — heavier than it needs to be.

## Goal

Saving the name should "just happen" on unfocus (and Enter) with no Save button.
The locked name reads as a single chip with a small pencil icon **inside** it.

## Locked decisions (from grilling)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Lock/Edit pattern | **Keep it.** Type name → blur → field locks to a read-only chip; re-edit via the icon. Only the Save button goes. |
| 2 | Edit affordance | **Pencil-square SVG icon** (Lucide-style "square-pen": pencil over a rounded square), replacing the "Edit" text button. |
| 3 | Icon source | **Real inline SVG**, embedded now. Swappable later. |
| 4 | Icon placement | **Overlaid in the existing chip.** Keep the `.locked-value` box; absolutely-position the icon over its right edge; add `padding-right` so the name text (ellipsis) never runs under it. |
| 5 | Commit triggers | **Blur + Enter** stay. `commitName()` logic unchanged. |
| 6 | Per-keystroke save | **Unchanged** — closing the popup mid-edit (no blur) still keeps typed text. |
| 7 | Empty name | **Unchanged** — blank stays editable/unlocked (nothing to lock); fresh install opens in edit mode. |
| 8 | Accessibility | Icon is a real `<button type="button">` with `aria-label="Edit display name"`, keyboard-focusable. |

## Changes

### `extension/popup.html`
- Editable state (`:340-348`): delete `<button id="name-save">Save</button>`. Input
  becomes full width (drop the pointless flex sibling; keep `#name` as-is).
- Locked state (`:336-339`): replace `<button id="name-edit">Edit</button>` with
  `<button id="name-edit" type="button" aria-label="Edit display name">` wrapping an
  inline Lucide square-pen SVG.
- CSS: `.locked-value` gets `padding-right` to clear the icon; add a rule positioning
  `#name-edit` absolutely at the chip's right edge — bare (no background/border),
  `--muted` → `--fg` on hover, `cursor: pointer`, ~16px. `.field-locked` becomes the
  positioning context (`position: relative`).

### `extension/popup.js`
- `el` map (`:58`): remove `nameSave`.
- Remove the Save click handler (`:130`).
- Remove the blur-skip guard (`:135`) — blur now always commits.
- `commitName()` (`:218-224`): unchanged.
- Edit-icon click handler (`:140-143`): unchanged (`setFieldLocked(false)` + focus).

## Acceptance criteria

- No "Save" button anywhere in the Display Name field.
- Type a name → move focus out of the field → name trims, saves, and locks to the chip
  with the pencil icon at the right.
- Enter while editing → same commit/lock.
- Pencil icon sits **inside** the chip, never overlaps the text, is keyboard-focusable,
  and exposes an aria-label.
- Closing the popup mid-edit (no blur) still keeps the typed text.
- Clicking the pencil reopens the editable input, focused.

## Files touched

- `extension/popup.html`
- `extension/popup.js`
