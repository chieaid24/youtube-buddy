# Task: Themeable, high-visibility buddy color palettes

## Problem

Current buddy colors (`shared.js:165`, 5 fixed hex) wash out against YouTube's dark player, red watched-bar, and bright thumbnails — hard to see. Want (a) a redesigned **high-contrast default** every user gets out of the box, and (b) optional **named palette themes** a user can switch to for personal taste.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Root cause | Low contrast vs YouTube UI + want themes. Not collision, not size. |
| 2 | Scope | **Local** render preference only. Stored in `chrome.storage.local`. Zero backend change. My palette ≠ my buddy's palette is fine. |
| 3 | Friend→color mapping | Keep `buddyColor()` clientId hash; just index into the **selected** palette array instead of one fixed set. |
| 4 | Palettes shipped | **Default** (high-contrast, always) + **Tropical** + **Cool** + **Pastel**. Colorblind-safe dropped. |
| 5 | Picker UI | Popup `<select>` + live swatch-strip preview. |
| 6 | Live apply | Open tabs recolor instantly via `chrome.storage.onChanged` → re-render. No reload. |

## Scope of change

### `shared.js`

- Replace single `BUDDY_PALETTE` const with a `PALETTES` map: `{ default, tropical, cool, pastel }`, each an array of ≥5 visually-distinct colors, **all clear of YouTube red** (existing constraint). `default` tuned for max contrast on dark player + thumbnails.
- Add `palette` to `getConfig()` defaults (`"default"`) and to `setConfig()` writable keys.
- `buddyColor(clientId)` reads selected palette from config (or accepts override) → hash indexes into chosen palette's array. Keep deterministic hash so a friend keeps their slot; switching theme just recolors.

### `popup.js` / `popup.html`

- Add `Palette:` `<select>` (Default / Tropical / Cool / Pastel) + swatch strip below that updates on change.
- On change → `setConfig({ palette })`. Roster swatches (`popup.js:384`) already use `buddyColor`, recolor automatically.

### Content scripts (`renderer.js` / `content.js`)

- Content script reads `palette` from storage on load and on `chrome.storage.onChanged`; triggers a re-render (renderer already redraws on mutation/navigate — add a storage-change re-render trigger). `renderer.js:143` marker + `:223` segment pick up new colors via `buddyColor`.

### Migration

- Existing users have no `palette` key → falls to `"default"`. Their buddy colors silently shift to the new high-contrast set. Intended, no migration code needed.

## Out of scope

- Hash **collisions** (>distinct buddies than colors → same color). Deprioritized. More colors per palette helps but no collision-avoidance algorithm.
- Synced/shared palettes, per-friend manual color assignment, colorblind-safe set.
- Self color (renderer only draws buddies; "you" has no marker).

## Acceptance criteria

1. Fresh install → buddies render in the new high-contrast default; clearly visible on dark player, red-bar region, and bright thumbnails.
2. Popup palette `<select>` lists 4 palettes; swatch strip previews the highlighted one.
3. Selecting a palette recolors markers + thumbnail segments + popup roster swatches **instantly** in an open YouTube tab (no reload).
4. Same friend keeps a stable color within a given palette across videos/thumbnails/popup.
5. Choice persists across restart (`chrome.storage.local`). No backend calls added.
