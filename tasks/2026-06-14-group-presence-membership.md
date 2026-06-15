# Task: Explicit Group presence (membership independent of watch data)

> Status: defined (grilled), not started. Created 2026-06-14.

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
1. B sets a code (never watches). A joins the same code -> A's popup shows **In group ·
   1 buddy** with B rostered as "joined", not "Waiting".
2. While A watches, B connects -> within ~60s A sees an on-page toast and B in the
   roster.
3. Five presence-only members fill the cap; a 6th is locked out (409 / "Group full").
4. A changes/re-rolls/joins-over -> A's presence row gone from the old code
   (best-effort), no longer rostered for others.
5. Sharing off -> A still present and counted; no marker for A.

## Test plan
- **Backend (`test/index.spec.ts`, vitest):** new GET `{progress,presence}` shape;
  `POST /presence` stores + server `updatedAt`; `DELETE /presence` idempotent; cap counts
  presence rows; 400s for missing `code`/`clientId`; CORS/405. Update existing GET-shape
  assertions.
- **Extension:** manual (no harness) — drive the 5 acceptance criteria across two
  profiles against the local worker.
