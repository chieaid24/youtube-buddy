# Task: Explicit Group presence (membership independent of watch data)

> Status: **DONE** 2026-06-21. Presence endpoints (`POST`/`DELETE /presence`), structured `GET {progress,presence}`, union cap, `presence.js` content script, renderer 60s poll + join toast. Backend 28 tests green.

## Problem

Membership is **implicit** today: a person only exists under a Friend Code once they
POST a Progress Record, which `reporter.js` does only while actively watching a
`/watch` video (ad/live/Shorts/embed guards, `sharing` on). So when you Join a code,
`joinAndCommit` -> GET -> `groupView` sees `buddies.length === 0` -> **"Waiting for
buddy"** even though the other person already has the code set. There is no "I'm here"
signal decoupled from watching, and no feedback when someone joins.

## Goal

Make setting a Friend Code behave like **entering a room**: you appear to others the
instant you join (no watch data required), others get told someone connected, and you
see the headcount.

## Locked decisions (from grilling)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Presence model | **Sticky flag** — written on join, deleted on code change, 14-day TTL, no online/offline heartbeat. Means "has joined", not "currently online". |
| 2 | Presence-only member | **Full member** — flips Waiting->In group, shows in roster ("joined", no position), and **counts toward the 5-person cap**. |
| 3 | Feedback surface | **Popup live count/roster + on-page toast.** Renderer diffs the presence set; new arrival -> transient YouTube toast. Baseline-silent on first read; **joins only**, no "left" toast. |
| 4 | Backend wire shape | **Structured GET** — `GET /?code=X` -> `{ progress: [...], presence: [...] }`. Breaks the flat-array contract on purpose. |
| 5 | Refresh cadence | **Re-assert (idempotent upsert)** on create/join, popup-open, YouTube load/nav, and name-commit. Refreshes TTL; backfills pre-feature installs. |
| 6 | Sharing toggle | **Independent** — Sharing off = still present/counted, only video position stops. |
| 7 | DELETE coverage | **All leave-paths** (Change code, Re-roll, Join-over), **best-effort**: on failure, proceed locally and let the 14-day TTL clean up. |
| 8 | Live updates | **Add a ~60s poll** to the renderer: re-GET, diff presence (toast), refresh markers. ~1 GET/min/open tab. |
| 9 | Terminology | **No glossary churn here** — a parallel worktree owns the rename to "room"/"connected" and will overwrite. New strings stay locally consistent; CONTEXT.md/ADR untouched. |

## Data model

New KV key, **separate from Progress Records**:

```
{code}:presence:{clientId}   ->   { clientId, name, updatedAt }
```

- `updatedAt` server-set (last assert time; doubles as roster "last seen"). `joinedAt`
  dropped — re-assert would need a read-before-write to preserve it; not worth it.
- `name` **optional** (a user can join before naming themselves; roster falls back to
  "Buddy").
- `expirationTtl` = 14 days (`TTL_SECONDS`), same as progress.
- The infix `presence` can't collide with a `clientId` (8 hex chars).

## Backend changes (`backend/src/index.ts`)

1. **`POST /presence?code=X`** — body `{ clientId, name? }`. Validate `clientId`
   non-empty string; `name` optional string (default `""`). Server sets `updatedAt`.
   Put under `{code}:presence:{clientId}`, TTL 14d. Subject to the same cap check.
2. **`DELETE /presence?code=X&clientId=Y`** — delete the key. Idempotent: `{ ok: true }`
   even when absent. Missing `code`/`clientId` -> 400.
3. **`GET /?code=X`** — return `{ progress: [...], presence: [...] }`. Split the
   prefix-scan results by key shape (`{code}:presence:*` -> presence, else progress).
4. **Cap check** — derive the member set from the **union** of distinct `clientId`s
   across progress keys (`split(":")[0]`) and presence keys (`presence:{clientId}` ->
   second segment). A presence row reserves a slot. Applies to both `POST /` (progress)
   and `POST /presence`.

## Extension changes

**`shared.js` (`window.YTB`)**
- `getRecords(code)` -> returns `{ progress, presence }` (single fetch). Update all
  callers.
- New `assertPresence(code)` -> `POST /presence` with `{ clientId, name }` from config.
  Independent of `sharing`. Best-effort.
- New `deletePresence(code, clientId)` -> `DELETE /presence`. Best-effort.
- `groupView(records, myClientId)` -> accept the structured `{ progress, presence }`.
  A **buddy** = any foreign `clientId` present in *either* set; use the latest progress
  record for position/last-seen, else the presence row ("joined", no position).
  `iAmMember` = I'm in either set. `locked` = union of distinct foreign `clientId`s >=
  `MAX_MEMBERS` and I'm not a member.

**`popup.js`**
- `createAndCommit` / `joinAndCommit` -> `assertPresence(newCode)` after committing the
  code. (Join's subsequent `refreshStatus` is what now correctly shows an
  already-present owner — the core fix.)
- `init()` -> `assertPresence(code)` when a code exists (refresh + backfill).
- `commitName()` -> re-assert presence so the name propagates immediately.
- Leave-paths (`clearCodeAndChoose`, `createAndCommit`-as-reroll,
  `joinAndCommit`-over-existing) -> `deletePresence(oldCode, myClientId)` before
  switching; ignore failures.
- `refreshStatus` / `renderRoster` -> driven by the merged `groupView`; presence-only
  buddy renders with `formatLastSeen(updatedAt)` ("joined Xm ago") and no position.

**`renderer.js`**
- Use `records.progress` for markers/thumbnails (presence rows have no `videoId`, so the
  existing `!r.videoId` skip already excludes them once the structured object is
  destructured).
- Add a **~60s poll** (`setInterval`) calling `refresh()` then re-render — gives live
  markers + presence.
- Maintain a baseline `Set` of known foreign `clientId`s; on each refresh, any new id
  (and not on the very first/baseline read) -> **toast** "`<name>` joined" (fallback
  "A buddy joined"). Auto-dismiss ~4s, stack-safe, styled via the existing injected
  `<style>`.

**Presence assertion on YouTube (new tiny consumer)**
- Recommended: a new content-script file `presence.js` (loaded after `shared.js`),
  listening to `ytb:navigate`, calling `YTB.assertPresence(code)` **throttled** (once
  per load / ~5min), independent of `sharing` and not gated to `/watch`. Mirrors the
  reporter/renderer split.
- Requires `manifest.json` `content_scripts.js` order update + a one-line note in
  `CLAUDE.md`'s load-order description.
- **Open structural choice:** new file vs folding the assert into the renderer poll
  (the latter muddies the renderer's display-only charter). Defaulting to new file.

## Edge cases
- Join a code nobody owns -> you become the first presence row; status "Waiting" until a
  buddy appears.
- Sharing off -> presence still asserted; position not.
- DELETE fails offline -> local switch proceeds; old row TTLs out.
- Multiple open YouTube tabs -> each polls and may toast; baseline-per-tab keeps it from
  storming.
- Name blank at join -> presence `name:""`; roster/toast show "Buddy".

## Non-goals
- Online/offline heartbeat or "left the room" toast.
- Terminology rename to "room"/"connected" (parallel worktree owns it).
- Action-icon badge / background service worker (ADR-0001 preserved).
- Deleting old **Progress** Records on code change (still TTL-only, unchanged).

## Acceptance criteria
1. [x] B sets a code (never watches), A joins → A sees **In group**, B rostered, not "Waiting" — *verified in code: `groupView` treats a presence-only owner as a buddy (harness test passed); join asserts presence + GETs.*
2. [x] While A watches, B connects → ~60s later A sees a toast + B in roster — renderer `setInterval(PRESENCE_POLL_MS=60s)` re-GETs; `notePresence` diffs and toasts new arrivals.
3. [x] Five presence-only members fill the cap; 6th locked out (409 "group full") — backend `currentMembers` counts presence rows (test: 6th presence AND 6th progress → 409).
4. [x] Leave-paths drop my presence row (best-effort) — `clearCodeAndChoose` + create/join-over call `deletePresence(oldCode, myClientId)`; `DELETE /presence` idempotent (tested).
5. [x] Sharing off → still present and counted, no marker — `assertPresence` is independent of `sharing` (presence.js + popup); reporter still gates POSTs on `sharing`.

*Items 1–2,5 backend-tested + code/logic-reviewed (`groupView` harness run); live two-profile run not automatable in this job.*

## Review

- **`backend/src/index.ts`** (subagent) — path-based routing; `POST /presence` (validate clientId, optional name, cap check, store `{code}:presence:{clientId}`), `DELETE /presence?...&clientId=` (idempotent), `GET /` now returns `{progress, presence}` (one prefix scan partitioned by key shape), shared `currentMembers()` union helper used by both POST paths, CORS `+DELETE`.
- **`backend/test/index.spec.ts`** (subagent) — 28 tests: GET-shape, presence store/updatedAt/optional-name, DELETE idempotent + 400s, cap counts presence rows, 405 via `PUT /`.
- **`extension/shared.js`** — `getRecords` → `{progress, presence}`; new `assertPresence(code)` / `deletePresence(code, clientId)` (best-effort, `assertPresence` independent of sharing); `groupView` rewritten for the structured shape (buddy = foreign id in either set; progress preferred over presence; cap = union of distinct foreign ids).
- **`extension/popup.js`** — create/join assert presence (+ delete old code's row); `init` re-asserts (refresh/backfill); `commitName` re-asserts so the name propagates; `clearCodeAndChoose` deletes presence. (Also fixed `createAndCommit` to land on an interactive dot via `refreshStatus`.)
- **`extension/renderer.js`** — refresh reads `records.progress` for markers; `notePresence` diffs foreign ids and toasts new arrivals (baseline-silent on first read); `showToast` + toast CSS; ~60s `setInterval` poll (token-guarded).
- **`extension/presence.js`** (new) + **`manifest.json`** — content script (after shared, before content) asserting presence on `ytb:navigate`, throttled ~5 min, ungated to /watch, independent of sharing.
- Verified: backend 28/28 green; `node --check` clean on all 4 JS files incl. presence.js; manifest JSON valid with the new load order; `groupView` merge/lock logic exercised via a node harness.

## Test plan
- **Backend (`test/index.spec.ts`, vitest):** new GET `{progress,presence}` shape;
  `POST /presence` stores + server `updatedAt`; `DELETE /presence` idempotent; cap counts
  presence rows; 400s for missing `code`/`clientId`; CORS/405. Update existing GET-shape
  assertions.
- **Extension:** manual (no harness) — drive the 5 acceptance criteria across two
  profiles against the local worker.
