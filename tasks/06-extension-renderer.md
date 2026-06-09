# Task 06 — Extension: renderer (show the Buddy's progress)

> Part of the [task breakdown](./INDEX.md). Track: **extension**. Depends on:
> [03 foundation](./03-extension-foundation.md) (Contract B — `window.YTB`; Contract C —
> `ytb:navigate` + `ytb:mutation`). Runs in parallel with [04 popup](./04-extension-popup.md)
> and [05 reporter](./05-extension-reporter.md) — disjoint files.

## Goal

Render the **Buddy's** Progress Records: a marker on the active video's progress bar, and
fractional bars on thumbnails across home/recommended/search/listing surfaces. Display-only —
no click-to-seek. PRD plan-of-record step 6.

## File you own

- `extension/renderer.js` — loaded as the **3rd** content-script file (after `shared.js` and
  `reporter.js`, before `content.js`; see manifest in
  [task 03](./03-extension-foundation.md)). Shares the content-script global scope; use
  `window.YTB` and `document` events only — **no `import`s**. Inject any CSS from JS (e.g. a
  `<style>` tag or inline styles) — there is no separate stylesheet file.

Do **not** edit `shared.js`, `content.js`, `reporter.js`, `manifest.json`, or popup files.

## Behavior (from the PRD — "Renderer")

- **Fetch + cache:** GET the code's records on content-script init **and on every SPA
  navigation**; cache the result for thumbnail rendering between fetches.
- **"Buddy" filter:** a record is the Buddy's iff `record.clientId !== myClientId`. Render
  only Buddy records.
- **Watch page (active video):** if the Buddy has a record for the **current** `videoId`,
  draw a marker on the player progress bar (`.ytp-progress-bar`) at position
  `timestamp / duration`. **Hover tooltip:** Buddy Display Name + formatted position
  (`YTB.formatTime(timestamp)`). Display-only — no click handler.
- **Thumbnails:** on home/recommended/search/listing surfaces, for any tile whose anchor
  `href` contains `/watch?v=<id>` matching a Buddy record, overlay a **small horizontal bar
  at the bottom of the thumbnail**, width `timestamp / duration`, in a **color distinct from
  YouTube's red "watched" bar** (pick something obviously different, e.g. a blue/teal). One
  bar per matching tile; for multiple Buddy records on the same video use the most recent
  (`max updatedAt`).
- **Re-apply on lazy-load:** the feed loads thumbnails as you scroll. Re-apply bars on the
  throttled `ytb:mutation` event. Make re-application **idempotent** — don't stack duplicate
  bars on a tile you've already decorated (e.g. mark decorated tiles with a data attribute).

## Contracts you consume (frozen in [task 03](./03-extension-foundation.md))

From `window.YTB`:

```js
await YTB.getRecords(code)   // → Array<ProgressRecord>; flat, everyone under the code
await YTB.getConfig()        // → { name, code, clientId, sharing } — need `code`
await YTB.ensureClientId()   // → myClientId, to filter out my own records
YTB.formatTime(seconds)      // → "M:SS" / "H:MM:SS" for the tooltip
```

**`ProgressRecord`**:
`{ clientId, name, videoId, timestamp, duration, updatedAt }`.

> If there is **no `code`** set in config, there is nothing to render — bail early.

From `content.js` (Contract C) on `document`:

```js
document.addEventListener("ytb:navigate", (e) => {
  // e.detail = { url, videoId }. Re-GET records, then:
  //  - if on a /watch page and a Buddy record exists for e.detail.videoId, draw/refresh the
  //    progress-bar marker;
  //  - re-scan visible thumbnails.
});
document.addEventListener("ytb:mutation", () => {
  // throttled; the feed lazy-loaded more tiles. Re-apply thumbnail bars (idempotently)
  // using the cached records — no need to re-GET here.
});
```

You do **not** detect navigation or DOM churn yourself — `content.js` owns the single
observer and emits these events. Register your listeners synchronously at the top level of
`renderer.js` so they're attached before `content.js` (loaded last) fires the initial
`ytb:navigate`.

## Suggested structure

```js
// renderer.js (content-script world; window.YTB available)
(() => {
  let cachedRecords = [];   // Buddy records only
  let myClientId = null;

  async function refresh() {
    const { code } = await YTB.getConfig();
    if (!code) { cachedRecords = []; return; }
    myClientId = myClientId || await YTB.ensureClientId();
    const all = await YTB.getRecords(code);
    cachedRecords = all.filter(r => r.clientId !== myClientId);
  }

  function renderWatchMarker(videoId) {
    // find the Buddy record for videoId; place a marker on .ytp-progress-bar at
    // timestamp/duration with a hover tooltip (name + YTB.formatTime(timestamp)).
  }

  function renderThumbnails() {
    // for each anchor href ~ /watch?v=ID matching a cached record, overlay a bottom bar
    // width timestamp/duration; skip tiles already decorated (data attribute); pick the
    // most-recent record per videoId.
  }

  document.addEventListener("ytb:navigate", async (e) => {
    await refresh();
    if (e.detail.videoId) renderWatchMarker(e.detail.videoId);
    renderThumbnails();
  });
  document.addEventListener("ytb:mutation", () => renderThumbnails());
})();
```

## Gotchas

- **YouTube SPA:** the progress bar and feed are rebuilt without a page reload; markers/bars
  get wiped on navigation and must be re-drawn (driven by `ytb:navigate`). Thumbnails stream
  in on scroll (driven by `ytb:mutation`).
- **Idempotency:** re-applying on every mutation must not stack duplicate overlays — guard
  with a `data-ytb-decorated` attribute (and clear/refresh when the underlying record
  changes).
- **videoId from thumbnails:** the tile's anchor `href` contains `/watch?v=<id>` — parse the
  `v=` param from the href. The active video's id comes from `e.detail.videoId`.
- **Distinct color:** YouTube's own "already watched" progress bar is red; the Buddy bar must
  be visibly different so users don't confuse it with their own history.
- **Display-only:** no click/seek behavior on the marker for the MVP (tooltip only).
- Reads continue **regardless of the Sharing toggle** — Sharing only gates POSTing
  ([task 05](./05-extension-reporter.md)), never rendering.
- No `import`s; rely on the global `YTB` and the `ytb:*` events.

## Acceptance criteria

- On a `/watch` page where the Buddy has a record for that video, a marker appears on the
  progress bar at `timestamp/duration` with a tooltip showing the Buddy's Display Name +
  formatted position. No click behavior.
- On home/recommended/search/listing pages, **every** video the Buddy has a live (≤14-day)
  record for shows a fractional bottom bar on its thumbnail (not just the latest one), in a
  color distinct from YouTube's red watched-bar.
- Bars re-apply correctly as the feed lazy-loads and after SPA navigation, without stacking
  duplicates.
- Rendering still works with Sharing off.

## Related

- [03 foundation](./03-extension-foundation.md) — `YTB` + `ytb:navigate`/`ytb:mutation`.
- [05 reporter](./05-extension-reporter.md) — the write half; independent of this file.
- [CONTEXT.md](../CONTEXT.md) — terminology ("Buddy", "Progress Record").
