# Task: Themeable, high-visibility buddy color palettes

> Status: **DONE** 2026-06-21. `PALETTES` map (default/tropical/cool/pastel), popup picker + live swatch preview, instant recolor via cached `_activePalette` + `chrome.storage.onChanged`.

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

1. [x] Fresh install → new high-contrast `default` (6 saturated hues, all clear of red) — `palette` defaults to `"default"`.
2. [x] Popup `<select>` lists 4 palettes; swatch strip previews the highlighted one — `renderSwatchStrip`.
3. [x] Selecting recolors markers + thumbnail segments + roster swatches instantly, no reload — *renderer re-renders on `chrome.storage.onChanged.palette`; popup re-renders roster + preview on change* (code-reviewed; no live-browser harness in this job).
4. [x] Same friend keeps a stable color within a palette — deterministic `hashClientId % palette.length`.
5. [x] Persists across restart (`chrome.storage.local`); no backend calls added — `setConfig({ palette })`, backend untouched.

## Review

- `extension/shared.js` — replaced `BUDDY_PALETTE` with `PALETTES` (default/tropical/cool/pastel, ≥5 colors each, no pure red); added `_activePalette` cache + `paletteColors(name)`; `buddyColor(clientId, paletteName?)` now indexes the active/overridden palette (still sync, still hash-stable). `getConfig`/`setConfig` gained the `palette` key (default `"default"`).
- `extension/renderer.js` — fallback color → `PALETTES.default[0]`; seeds `_activePalette` from config on load and recolors live on `chrome.storage.onChanged` (re-renders cached records, no re-GET).
- `extension/popup.js` — `el.palette`/`el.swatchStrip`; seeds cache + picker + preview on init; change handler persists + recolors roster (`currentRosterBuddies`) and preview with no reload; added `renderSwatchStrip`.
- `extension/popup.html` — `Buddy Colors` `<select>` + `#swatch-strip` field above Sharing; `select` + `.swatch-strip` CSS.
- Verified: `node --check` clean across all 3 JS files; no `BUDDY_PALETTE` references remain; palettes ≥5/no-dups/no-pure-red; backend untouched (16 tests still green).
