# Task 05 — Extension: reporter (report own watch progress)

> Part of the [task breakdown](./INDEX.md). Track: **extension**. Depends on:
> [03 foundation](./03-extension-foundation.md) (Contract B — `window.YTB`; Contract C —
> `ytb:navigate`). Runs in parallel with [04 popup](./04-extension-popup.md) and
> [06 renderer](./06-extension-renderer.md) — disjoint files.

## Goal

Report **this user's own** Progress Records from `/watch` pages, with all the skip-guards so
ads, live streams, Shorts, and embeds never produce records. PRD plan-of-record step 5.

## File you own

- `extension/reporter.js` — loaded as the **2nd** content-script file (after `shared.js`,
  before `renderer.js` and `content.js`; see manifest in
  [task 03](./03-extension-foundation.md)). It shares the content-script global scope with
  the others; communicate via `window.YTB` and `document` events only — **no `import`s**.

Do **not** edit `shared.js`, `content.js`, `renderer.js`, `manifest.json`, or popup files.

## Behavior (from the PRD — "Reporter")

Only act on `/watch` pages. Read `videoId` from the `v=` URL param (or use
`e.detail.videoId` from the `ytb:navigate` event) and position from the main player
`<video>` (`document.querySelector('video')`).

**POST on each of:**
- a **60-second `setInterval`** while the video is playing,
- the **`pause` event**, and
- **SPA navigation away** — capture the final position before the video changes.

**Skip the POST when any of these hold:**
- **Sharing is off** — `config.sharing === false`.
- **An ad is playing** — the player has the `ad-showing` class
  (`document.querySelector('.html5-video-player.ad-showing')` or `.ad-showing` on the player
  container). During ads `video.currentTime` is the *ad's* clock and would corrupt the record.
- **`duration` is not finite** — live streams report `Infinity`; skip.
- **`currentTime < 5` seconds** — noise; skip.
- **The page is an `/embed/` frame** — content script must not report from embeds.
- (Shorts `/shorts/…` are not `/watch` pages, so the "only on `/watch`" guard already
  excludes them.)

## Contracts you consume (frozen in [task 03](./03-extension-foundation.md))

From `window.YTB`:

```js
await YTB.getConfig()    // → { name, code, clientId, sharing } — check `sharing`, get name/code
await YTB.ensureClientId()  // → clientId (stable per install)
await YTB.postProgress({ clientId, name, videoId, timestamp, duration })
                            // POSTs to BACKEND_URL/?code=… ; see note on where `code` comes from
```

> **Where does `code` come from?** Check `shared.js`: the recommendation in
> [task 03](./03-extension-foundation.md) is that `postProgress` reads `code` from config
> internally, so you pass only the 5 record fields. If `shared.js` instead expects `code` as
> an argument, follow what it actually does. Either way, if there is **no `code` set**, do not
> POST (nothing to pair with).

From `content.js` (Contract C) on `document`:

```js
document.addEventListener("ytb:navigate", (e) => {
  // e.detail = { url, videoId }  — fired on load and every SPA nav.
  // Use this to (re)bind to the current video and reset the interval, and to capture the
  // final position of the OUTGOING video before switching.
});
```

You do **not** detect navigation yourself — `content.js` owns the single observer. Register
your listener synchronously at the top level of `reporter.js` so it is attached before
`content.js` (which loads last) dispatches the initial `ytb:navigate`.

## Suggested structure

```js
// reporter.js (runs in the content-script world; window.YTB available)
(() => {
  let intervalId = null;
  let videoEl = null;

  function buildRecord() {
    // returns { videoId, timestamp, duration } from URL + querySelector('video'),
    // or null if not on /watch.
  }

  async function maybePost() {
    const config = await YTB.getConfig();
    if (!config.sharing || !config.code) return;
    if (isEmbed() || isAdShowing()) return;
    const rec = buildRecord();
    if (!rec) return;
    if (!Number.isFinite(rec.duration)) return;   // live stream
    if (rec.timestamp < 5) return;                 // noise
    const clientId = await YTB.ensureClientId();
    await YTB.postProgress({ clientId, name: config.name, ...rec });
  }

  function bindVideo() {
    // attach `pause` listener to the current <video>; (re)start the 60s interval that
    // only posts while !video.paused. Clear the previous interval/listeners first.
  }

  document.addEventListener("ytb:navigate", (e) => {
    // capture final position of the outgoing video, then rebind to the new one.
    // If leaving a /watch page, do a final maybePost() for the old video first.
  });
})();
```

Keep it simple and tolerant of failure (PRD allows minimal error handling — a failed POST is
fine to swallow). Always clear the previous `setInterval` and old video listeners on navigate
to avoid duplicate posts and leaks across SPA transitions.

## Gotchas

- **Ads:** the `ad-showing` guard is critical — without it you store the ad's `currentTime`.
- **SPA navigation:** YouTube does not reload. The same `<video>` element may be reused with a
  new source, or replaced — rebind on every `ytb:navigate`. Capture the **outgoing** video's
  final position before the URL/video changes.
- **Embeds:** an embedded player runs in an iframe whose URL is `/embed/…`; detect and skip.
- **`currentTime` during ads vs content** — only read it when no ad is showing.
- No `import`s; rely on the global `YTB` and the `ytb:navigate` event.

## Acceptance criteria

- While watching a `/watch` video with Sharing on, a Progress Record is POSTed within ~60s,
  on pause, and when navigating away (final position captured).
- **No** record is created when: Sharing is off; an ad is showing; the stream is live
  (`duration` non-finite); `currentTime < 5s`; the player is an `/embed/` frame; or the page
  is a Short.
- Toggling Sharing off (via the popup, [task 04](./04-extension-popup.md)) stops new POSTs —
  verify no new `updatedAt` server-side.

## Related

- [03 foundation](./03-extension-foundation.md) — `YTB` + `ytb:navigate` contracts.
- [04 popup](./04-extension-popup.md) — writes the `sharing` flag this task reads.
- [06 renderer](./06-extension-renderer.md) — the read/render half; independent of this file.
