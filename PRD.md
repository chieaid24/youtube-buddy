# PRD: YouTube Buddy (watch-progress sharing extension)

> Terminology in this document follows [CONTEXT.md](./CONTEXT.md). Key architectural decisions are recorded in [docs/adr/](./docs/adr/).

## Summary

A Chrome extension that lets two friends share their YouTube watch progress. Each person pairs via a Friend Code. The extension reports the user's position in the current video to a backend and reads the Buddy's positions back, displaying them as a marker on the active video's progress bar and as fractional bars on thumbnails for any video the Buddy has watched recently.

This is a **bare MVP** scoped to two friends. Hardcoded assumptions and minimal error handling are acceptable. No auth, no accounts, no real-time sync.

## Goals

- Pair two users with a shared Friend Code (status: Unpaired → Waiting → Paired).
- Report Progress Records — `{ clientId, name, videoId, timestamp, duration }` — from the content script while watching.
- Show the Buddy's positions on (a) the active video's progress bar and (b) thumbnails on home/recommended/search/listing pages, for every video the Buddy has a live (≤14-day-old) Progress Record on.
- Let the user pause Sharing without losing sight of the Buddy's markers.

## Non-goals

- Real-time / live "watch together" sync (deliberately excluded).
- More than two users per Friend Code (the model tolerates it, but UI assumes one Buddy).
- Authentication, user accounts, or abuse protection beyond the Friend Code itself.
- Mobile, Firefox, or non-Chromium browsers.
- **YouTube Shorts** (`/shorts/…`) — different player DOM, progress meaningless for loops.
- **Embedded players** (`/embed/…` iframes on third-party sites) — content script must not report from them.
- **Live streams** — `video.duration` is `Infinity`; skip reporting.
- Click-to-seek from the Buddy's marker (display + tooltip only for MVP).

## Decisions (resolved 2026-06-09 grilling session)

| Decision | Choice |
|---|---|
| Data model | Per-video history: one Progress Record per `(code, clientId, videoId)` |
| Record cap | KV `expirationTtl` of **14 days**, refreshed on every write |
| Identity | Generated **Client ID** (random, stable per install); Display Name is cosmetic |
| Sync owner | **Content script only** — no background worker, no `chrome.alarms` ([ADR-0001](./docs/adr/0001-content-script-owned-sync.md)) |
| Duration | Stored in the Progress Record so thumbnail fractions need no DOM scraping |
| Marker UX | Display-only marker + hover tooltip (Buddy name + position); no seek |
| Paired status | Three states; Paired = a record from another Client ID exists under the code |
| Privacy | Popup "Sharing" toggle gates POSTs; reads continue regardless |
| Backend tests | Rewrite the stale Hello-World spec as part of the backend changes |

## Current state

- **Cloudflare Worker backend** in TypeScript (`backend/src/index.ts`) — built and locally tested via `wrangler dev` at `localhost:8787`, **but does not yet match this PRD** (see "Backend changes required").
- **KV namespace** `PROGRESS` created and bound (id `7ca21ebc499844c9b6c109ccaf9e9bc1`), binding name `PROGRESS`.
- CORS (including `OPTIONS` preflight) implemented, `Access-Control-Allow-Origin: *`.
- `compatibility_date` in `wrangler.jsonc` is `2026-05-03` to match the installed Wrangler binary (4.86.0).
- `backend/test/index.spec.ts` is still the unmodified Hello-World template.
- Extension: nothing exists yet.

## Data model

One Progress Record per video per user:

- **KV key:** `` `${code}:${clientId}:${videoId}` ``
- **KV value:** `{ clientId, name, videoId, timestamp, duration, updatedAt }`
  - `clientId` — random stable id generated once per install (e.g. 8 hex chars)
  - `name` — Display Name, cosmetic only
  - `timestamp` — seconds into the video
  - `duration` — total video length in seconds (from `video.duration`)
  - `updatedAt` — epoch ms, set server-side
- **TTL:** `expirationTtl: 14 * 24 * 3600` on every `put` — actively-watched videos never expire; abandoned ones age out, which also bounds the GET prefix scan.

```json
[
  { "clientId": "a1b2c3d4", "name": "aidan",  "videoId": "abc123", "timestamp": 412, "duration": 1300, "updatedAt": 1781000000000 },
  { "clientId": "9f8e7d6c", "name": "matt",   "videoId": "abc123", "timestamp": 388, "duration": 1300, "updatedAt": 1780999700000 }
]
```

## Backend API

Two endpoints on the Worker, keyed by query param `code`.

### POST `/?code=<CODE>`

Body: `{ clientId, name, videoId, timestamp, duration }`. Stores under `` `${code}:${clientId}:${videoId}` `` with `updatedAt` and the 14-day TTL. Returns `{ ok: true }`.

### GET `/?code=<CODE>`

Prefix-scans `` `${code}:` `` and returns a **flat array** of all live Progress Records under the code (nulls filtered). The client splits "mine" vs "Buddy's" by comparing `clientId` — the server does no filtering.

### Backend changes required (vs current code)

1. Key scheme `code:name` → `code:clientId:videoId`.
2. Accept and store `clientId` and `duration`; reject bodies missing required fields (400).
3. Add `expirationTtl` (14 days) to the `put`.
4. Rewrite `backend/test/index.spec.ts` (vitest-pool-workers is already configured): POST stores and returns ok, GET lists records for a code only, missing-code 400, missing-field 400, CORS headers present, method 405.

## Extension requirements (to build)

### Manifest

- Manifest V3.
- Permissions: `storage` only. Host permissions: `*://*.youtube.com/*` and the deployed Worker URL.
- **No background service worker, no `alarms`** (ADR-0001). Components: one content script matched on YouTube, an action popup.

### Popup (`popup.html` + `popup.js`)

- Input for the user's Display Name.
- "Generate code" button (client-side only — e.g. random word + 2 digits, `WOLF-42`) and an "Enter code" input to join an existing one (normalize to uppercase).
- Persist `name`, `code`, `clientId` (generated on first run), and `sharing` in `chrome.storage.local`.
- **Pairing status (three states):**
  - *Unpaired* — no code set.
  - *Waiting for buddy* — code set, but GET shows no record from another Client ID.
  - *Paired* — a foreign-`clientId` record exists; show the Buddy's Display Name and last-seen time (`updatedAt`).
- **Sharing toggle** — when off, the content script stops POSTing but keeps fetching/rendering Buddy markers.
- Show the configured backend URL (hardcoded constant in one shared place).

### Content script (`content.js`) — owns the entire sync loop

**Reporter (own progress):**
- Only on `/watch` pages; read `videoId` from the `v=` URL param and position from `document.querySelector('video')`.
- POST on: a 60-second `setInterval` while playing, the `pause` event, and SPA navigation away (capture the final position).
- Skip the POST when: Sharing is off; an ad is playing (player has the `ad-showing` class — `currentTime` would be the *ad's* time); `duration` is not finite (live streams); `currentTime < 5s` (noise); or the page is an `/embed/` frame.

**Renderer (Buddy progress):**
- GET on content-script init and on every SPA navigation; cache the result for thumbnail rendering.
- *Watch page:* if the Buddy has a record for the current `videoId`, draw a marker on the player progress bar at `timestamp / duration`. Hover tooltip: Buddy name + formatted position. Display-only — no click behavior.
- *Thumbnails:* on home/recommended/search/listing surfaces, for any tile whose anchor `href` contains `/watch?v=<id>` matching a Buddy record, overlay a small horizontal bar at the bottom of the thumbnail, width `timestamp / duration` (distinct color from YouTube's red watched-bar). Re-apply as the feed lazy-loads.

**SPA navigation:** YouTube doesn't full-reload. Use a `MutationObserver` (or URL polling) to detect navigation and re-trigger reporting/rendering; the same observer handles lazy-loaded thumbnails.

## Suggested file structure

```
youtube-buddy/
├─ backend/              # built; needs the changes above, then deploy
│  ├─ src/index.ts
│  ├─ test/index.spec.ts # rewrite
│  └─ wrangler.jsonc
├─ extension/            # TODO (no background.js — ADR-0001)
│  ├─ manifest.json
│  ├─ content.js
│  ├─ popup.html
│  └─ popup.js
├─ CONTEXT.md
├─ docs/adr/
├─ .gitignore
└─ README.md
```

## Known gotchas (carry these forward)

- **YouTube SPA:** no page reload on navigation; a `MutationObserver` is required both to detect video changes and to re-render thumbnail markers as the feed loads.
- **Ad playback:** during ads, `video.currentTime` is the ad's clock. Reporting without the `ad-showing` guard corrupts records.
- **videoId extraction:** active video from URL `v=` param; thumbnails expose it via the anchor `href` (`/watch?v=...`).
- **CORS:** handled in the Worker (`*`); the extension's origin will be `chrome-extension://...`.
- **Friend Code as weak secret:** anyone with the code can read/write that pair's data. Acceptable for two friends; do not present as secure.
- **Deploy step:** the Worker has only been tested against a *local* KV store. After `wrangler deploy`, the live Worker uses the *remote* KV namespace, which starts empty.
- **Hand-written `Env`:** after changing bindings in `wrangler.jsonc`, run `npm run cf-typegen` and keep the `Env` interface in `src/index.ts` in sync.

## Plan of record (ordered)

1. Backend: key scheme + `clientId`/`duration` + TTL + validation.
2. Backend: rewrite tests; `npm test` green.
3. Deploy (`wrangler deploy`), record the public URL in the extension's constant.
4. Extension: manifest + popup (identity, codes, status, toggle).
5. Extension: content-script reporter.
6. Extension: content-script renderer (watch page, then thumbnails).

## Acceptance criteria

- Two browsers, two Display Names (collisions harmless — identity is Client ID), same Friend Code.
- User A watches a video; within ~60s (or on B's refresh/navigation) B sees A's marker on that video's progress bar, with A's name in the tooltip.
- On B's home/recommended page, the thumbnail for *every* video A touched in the last 14 days shows a fractional bar — not just A's latest video.
- A's popup shows *Waiting for buddy* before B ever syncs, and *Paired* (with B's name + last-seen) after.
- Toggling Sharing off stops A's POSTs (verify no new `updatedAt` server-side) while A still sees B's markers.
- Pairing, identity, and the Sharing flag survive browser restart (`chrome.storage.local`).
- No Progress Records are created from ads, live streams, Shorts, or embeds.
