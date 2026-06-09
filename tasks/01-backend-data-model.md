# Task 01 — Backend: new data model + validation + tests

> Part of the [task breakdown](./INDEX.md). Track: **backend**. Depends on: nothing.
> Blocks: [02 deploy](./02-backend-deploy.md). Runs fully in parallel with the entire
> extension track ([03](./03-extension-foundation.md)–[06](./06-extension-renderer.md)).

## Goal

Migrate the Cloudflare Worker from the legacy `code:name` key scheme to the PRD's
per-video model, add `clientId` + `duration`, a 14-day TTL, and request validation; then
**rewrite** the stale Hello-World test suite to cover the new behavior. `npm test` must be
green.

This task combines PRD plan-of-record steps 1 and 2 — the implementation and its tests are
one tightly-coupled unit and must not be split across agents.

## Files you own

- `backend/src/index.ts` — the Worker.
- `backend/test/index.spec.ts` — currently the unmodified Hello-World template; rewrite it.

Do **not** touch `extension/` — that is the parallel track.

## Context: current code (what exists today)

`backend/src/index.ts` today uses the **legacy** scheme:

- KV key: `` `${code}:${name}` ``
- Body type `{ name, videoId, timestamp }`, stored with `updatedAt` (no TTL).
- `GET` prefix-scans `` `${code}:` `` and returns a flat array (nulls filtered).
- CORS is wide open (`Access-Control-Allow-Origin: *`) with an `OPTIONS` preflight handler.
- `Env` interface is **hand-written** as `{ PROGRESS: KVNamespace }`.

The KV binding is `PROGRESS` (id `7ca21ebc499844c9b6c109ccaf9e9bc1`) in `wrangler.jsonc`.
`compatibility_date` is `2026-05-03`. The binding does **not** change in this task.

## Target data model (from the PRD)

One **Progress Record** per video per user.

- **KV key:** `` `${code}:${clientId}:${videoId}` ``
- **KV value (JSON):**
  ```json
  {
    "clientId": "a1b2c3d4",
    "name": "aidan",
    "videoId": "abc123",
    "timestamp": 412,
    "duration": 1300,
    "updatedAt": 1781000000000
  }
  ```
  - `clientId` — random stable id from the client (≈8 hex chars). Identity within a code.
  - `name` — Display Name, cosmetic only.
  - `timestamp` — seconds into the video.
  - `duration` — total video length in seconds.
  - `updatedAt` — epoch ms, **set server-side** (`Date.now()`), never trusted from the body.
- **TTL:** `expirationTtl: 14 * 24 * 3600` on **every** `put`. Active videos keep getting
  rewritten so they never expire; abandoned ones age out, which also bounds the GET scan.

## Backend HTTP API (the wire contract — shared with the extension track)

This is the contract the extension's `shared.js` API client (task
[03](./03-extension-foundation.md)) is written against. Keep it exact.

### `POST /?code=<CODE>`

- Body: `{ clientId, name, videoId, timestamp, duration }`.
- Stores under `` `${code}:${clientId}:${videoId}` `` with server-set `updatedAt` and the
  14-day `expirationTtl`.
- Returns `{ ok: true }` (200).

### `GET /?code=<CODE>`

- Prefix-scans `` `${code}:` `` and returns a **flat JSON array** of all live Progress
  Records under the code (nulls filtered out).
- The server does **no** "mine vs Buddy" filtering — the client splits by comparing
  `clientId`. Return everyone's records for the code.

### Cross-cutting

- `OPTIONS` → 204/200 with CORS headers (preflight). Keep the existing wide-open CORS
  (`Access-Control-Allow-Origin: *`, allow `GET, POST, OPTIONS`, allow `Content-Type`) —
  the extension origin is `chrome-extension://…`.
- Any other method → **405** `{ error: "method not allowed" }`.

## Validation (new — required)

- Missing `?code=` → **400** `{ error: "missing code" }` (already present; keep it).
- `POST` body missing **any** required field (`clientId`, `name`, `videoId`,
  `timestamp`, `duration`) → **400** with an error message. Decide a sane policy for types
  (e.g. `timestamp`/`duration` must be finite numbers) and keep it simple; the PRD only
  mandates rejecting bodies "missing required fields".
- `updatedAt` from the body is ignored; always overwrite with `Date.now()`.

## Steps

1. Update the `ProgressBody` interface to `{ clientId, name, videoId, timestamp, duration }`.
2. Change the POST key to `` `${code}:${clientId}:${videoId}` ``.
3. Add field validation → 400 on missing/invalid fields.
4. Add `{ expirationTtl: 14 * 24 * 3600 }` to the `put`.
5. Leave GET prefix-scan + flat-array behavior intact (it already matches the contract).
6. Rewrite `backend/test/index.spec.ts` (see below). Delete the Hello-World tests entirely.
7. `npm test` until green.

## Tests to write (rewrite `backend/test/index.spec.ts`)

Tests run **inside the Workers runtime** via `@cloudflare/vitest-pool-workers`
(`vitest.config.mts` → `defineWorkersConfig`). `cloudflare:test` provides:

- `env` — real bindings from `wrangler.jsonc`, so `env.PROGRESS` is a working KV namespace.
- `SELF` — a fetcher for integration-style `SELF.fetch(...)` calls.
- `createExecutionContext()` / `waitOnExecutionContext(ctx)` for unit-style
  `worker.fetch(req, env, ctx)` calls.

The existing template imports these already — reuse that import block; replace the body.

Cover at least (from the PRD's "Backend changes required" §4):

- **POST stores and returns ok** — POST a full body, expect `{ ok: true }`; then read the KV
  key (`env.PROGRESS.get("CODE:clientId:videoId")`) or GET it back and assert the stored
  record includes a server-set `updatedAt`.
- **GET lists records for a code only** — seed records under two different codes; GET one
  code; assert only that code's records come back, as a flat array.
- **Missing code → 400** on both GET and POST.
- **Missing required field → 400** on POST (e.g. omit `duration`).
- **CORS headers present** — assert `Access-Control-Allow-Origin: *` on a normal response
  and that `OPTIONS` returns the CORS headers.
- **Unsupported method → 405** (e.g. `PUT`/`DELETE`).

Use unique codes per test (e.g. include the test name) so KV state from one test does not
leak into another within the shared `env`.

Run a single test while iterating: `npx vitest run -t "name"`.

## Commands (run from `backend/`)

```bash
npm test                    # vitest in workerd — must be green when done
npx vitest run -t "name"    # single test
npm run cf-typegen          # only if you change wrangler.jsonc bindings (you should NOT here)
```

## Gotchas

- **Hand-written `Env`:** the `Env` interface in `src/index.ts` is maintained by hand. You
  are **not** changing bindings, so leave `Env` as `{ PROGRESS: KVNamespace }`. Only run
  `cf-typegen` if you add a binding (you should not need to).
- **`updatedAt` is server-authoritative** — never trust the client's value.
- KV in `vitest-pool-workers` is the real KV API but local; writes from earlier tests
  persist within a run unless you scope keys per test.

## Acceptance criteria

- POSTing `{ clientId, name, videoId, timestamp, duration }` stores under
  `code:clientId:videoId` with a server-set `updatedAt` and a 14-day TTL.
- GET returns a flat array of all live records for the given code, and nothing from other
  codes.
- Missing code → 400; missing POST field → 400; unsupported method → 405; CORS headers
  present on responses and preflight.
- `npm test` is green with the rewritten suite; no Hello-World tests remain.

## Next

Once green, hand off to [02 deploy](./02-backend-deploy.md). The extension's
[03 foundation](./03-extension-foundation.md) is written against the wire contract above, so
no further coordination is needed.
