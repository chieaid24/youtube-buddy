# Task breakdown — YouTube Buddy MVP

This directory decomposed [`PRD.md`](../PRD.md) into **independent work packages** that
separate agents could pick up. The completed packages (01–04) have been removed; only the
**unbuilt** work remains here. Each remaining file is self-contained: it embeds the contracts
and spec excerpts needed to do the work (note: `PRD.md` and `CLAUDE.md` are git-ignored and
will be absent from fresh worktrees).

> **Status (2026-06-09):** the backend (01–02) is built, deployed, and tested, and the
> extension foundation + popup (03–04) are built. What remains is the actual sync loop:
> **`reporter.js` (05)** and **`renderer.js` (06)**. Until those land, `manifest.json` still
> references the two missing files, so the extension will not load in Chrome, and
> `BACKEND_URL` in `extension/shared.js` is still the `http://localhost:8787` placeholder
> rather than the deployed `https://backend.aidanchien18-a8d.workers.dev`.

Canonical references (read for terminology and rationale):

- [`PRD.md`](../PRD.md) — full spec of record.
- [`CONTEXT.md`](../CONTEXT.md) — glossary. **Use these exact terms in code and UI copy:**
  Friend Code, Progress Record, Client ID, Display Name, Buddy, Paired, Sharing.
- [`docs/adr/0001-content-script-owned-sync.md`](../docs/adr/0001-content-script-owned-sync.md)
  — why there is **no background service worker**; the content script owns the sync loop.

## The work packages

| # | Package | Owns (files) | Status |
|---|---------|--------------|--------|
| 01 | Backend data model + tests | `backend/src/index.ts`, `backend/test/index.spec.ts` | ✅ done (task file removed) |
| 02 | Backend deploy | (no files; ops step) | ✅ done — deployed, smoke-tested |
| 03 | Extension foundation | `extension/manifest.json`, `extension/shared.js`, `extension/content.js` | ✅ done (task file removed) |
| 04 | Extension popup | `extension/popup.html`, `extension/popup.js` | ✅ done (task file removed) |
| 05 | [Extension reporter](./05-extension-reporter.md) | `extension/reporter.js` | ⬜ **not built** |
| 06 | [Extension renderer](./06-extension-renderer.md) | `extension/renderer.js` | ⬜ **not built** |

**No two tasks edit the same file** — 05 and 06 own disjoint files, so they remain safe to run
concurrently.

## Remaining work

Both remaining packages are pure consumers of the already-built foundation — they communicate
only via the `window.YTB` global and the `ytb:*` `document` events, with no `import`s.

- [05 — reporter](./05-extension-reporter.md): report this user's own Progress Records from
  `/watch` pages, with the ad / live-stream / Shorts / embed skip-guards.
- [06 — renderer](./06-extension-renderer.md): draw the Buddy's marker on the active video's
  progress bar and fractional bars on feed thumbnails.

Before either can run end-to-end, swap `BACKEND_URL` (and the matching `host_permissions`
entry in `manifest.json`) from the localhost placeholder to the deployed Worker URL above.

## Shared contracts (frozen)

The remaining packages are written against these. They are now **implemented in code** rather
than described in a task file — read the source for the exact shapes:

- **`window.YTB`** global — implemented in [`extension/shared.js`](../extension/shared.js):
  config storage, API client (`postProgress` reads the code from config; `getRecords(code)`
  takes it), formatting utils.
- **`document` event `ytb:navigate`** — emitted by [`extension/content.js`](../extension/content.js)
  on load and every SPA nav; `detail = { url, videoId }`.
- **`document` event `ytb:mutation`** — emitted (throttled) by `content.js` for feed lazy-load.
- **Backend HTTP API** (`POST`/`GET /?code=`) — the wire format; see
  [`backend/src/index.ts`](../backend/src/index.ts) and [`PRD.md`](../PRD.md).

`ProgressRecord` = `{ clientId, name, videoId, timestamp, duration, updatedAt }`. A record is
the **Buddy's** iff `record.clientId !== myClientId`; the server does no filtering.

## Definition of done (whole MVP)

The end-to-end criteria from the PRD:

- Two browsers, same Friend Code, different Display Names → each sees the other's marker on
  the active video and fractional bars on thumbnails for every video the Buddy touched in
  the last 14 days.
- Popup shows *Waiting for buddy* before the Buddy syncs, *Paired* (name + last-seen) after.
- Toggling **Sharing** off stops this user's POSTs but keeps rendering the Buddy's markers.
- Pairing/identity/Sharing survive a browser restart (`chrome.storage.local`).
- No Progress Records from ads, live streams, Shorts, or embeds.
