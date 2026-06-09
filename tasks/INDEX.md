# Task breakdown — YouTube Buddy MVP

This directory decomposes [`PRD.md`](../PRD.md) into **independent work packages** that
separate agents can pick up. Each file is self-contained: it embeds the contracts and
spec excerpts needed to do the work, so an agent does **not** need `PRD.md` present in its
checkout (note: `PRD.md` and `CLAUDE.md` are git-ignored and will be absent from fresh
worktrees). Cross-links point to sibling tasks and to the canonical docs for fuller context.

Canonical references (read for terminology and rationale, not strictly required to execute):

- [`PRD.md`](../PRD.md) — full spec of record.
- [`CONTEXT.md`](../CONTEXT.md) — glossary. **Use these exact terms in code and UI copy:**
  Friend Code, Progress Record, Client ID, Display Name, Buddy, Paired, Sharing.
- [`docs/adr/0001-content-script-owned-sync.md`](../docs/adr/0001-content-script-owned-sync.md)
  — why there is **no background service worker**; the content script owns the sync loop.

## The work packages

| # | File | Owns (files) | Depends on |
|---|------|--------------|------------|
| 01 | [Backend data model + tests](./01-backend-data-model.md) | `backend/src/index.ts`, `backend/test/index.spec.ts` | — |
| 02 | [Backend deploy](./02-backend-deploy.md) | (no files; ops step) | 01 |
| 03 | [Extension foundation](./03-extension-foundation.md) | `extension/manifest.json`, `extension/shared.js`, `extension/content.js` | — |
| 04 | [Extension popup](./04-extension-popup.md) | `extension/popup.html`, `extension/popup.js` | 03 (contracts) |
| 05 | [Extension reporter](./05-extension-reporter.md) | `extension/reporter.js` | 03 (contracts) |
| 06 | [Extension renderer](./06-extension-renderer.md) | `extension/renderer.js` | 03 (contracts) |

**No two tasks edit the same file** — that is what makes them safe to run concurrently.

## How to parallelize

Two independent tracks. The **backend track** (01 → 02) and the **extension track**
(03 → {04, 05, 06}) share nothing but an HTTP contract, so they run fully in parallel.

```
        ┌─ 01 backend data model + tests ──→ 02 deploy ─┐
START ──┤                                                ├──→ done
        └─ 03 extension foundation ──→ 04 popup ─────────┤
                                   ├─→ 05 reporter ──────┤
                                   └─→ 06 renderer ──────┘
```

- **Wave 1 (parallel):** `01` and `03`. Neither needs the other.
  - `03` hardcodes a **placeholder backend URL** (`http://localhost:8787`) so it does not
    wait on `02`. The real deployed URL is dropped in later (one-line change).
- **Wave 2 (parallel):** `04`, `05`, `06` — start once `03` has landed `shared.js` +
  `content.js` (they consume those contracts). `02` runs whenever `01` is done.
  - If you want **all** extension agents running at once, they may start against the
    contracts documented in [`03`](./03-extension-foundation.md#contracts) before that file
    is merged — the contracts are frozen there precisely so this is safe.

## Shared contracts (frozen — defined in full in task 03)

Every extension consumer task is written against these. Do not change them without updating
task 03 and every consumer:

- **`window.YTB`** global (from `shared.js`): config storage, API client, formatting utils.
- **`document` event `ytb:navigate`** (from `content.js`): fired on load and every SPA nav.
- **`document` event `ytb:mutation`** (from `content.js`): throttled, for feed lazy-load.
- **Backend HTTP API** (`POST`/`GET /?code=`): the wire format between `01` and the extension.

See [`03-extension-foundation.md`](./03-extension-foundation.md#contracts) for the exact shapes.

## Definition of done (whole MVP)

The acceptance criteria live in each task. The end-to-end criteria from the PRD:

- Two browsers, same Friend Code, different Display Names → each sees the other's marker on
  the active video and fractional bars on thumbnails for every video the Buddy touched in
  the last 14 days.
- Popup shows *Waiting for buddy* before the Buddy syncs, *Paired* (name + last-seen) after.
- Toggling **Sharing** off stops this user's POSTs but keeps rendering the Buddy's markers.
- Pairing/identity/Sharing survive a browser restart (`chrome.storage.local`).
- No Progress Records from ads, live streams, Shorts, or embeds.
