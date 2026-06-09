# Task 02 — Backend: deploy + record the public URL

> Part of the [task breakdown](./INDEX.md). Track: **backend**. Depends on:
> [01 backend data model + tests](./01-backend-data-model.md) (must be green first).
> Feeds: the backend URL constant in [03 extension foundation](./03-extension-foundation.md).

## Goal

Deploy the updated Worker to Cloudflare and record its public URL so the extension can point
at it. This is PRD plan-of-record step 3.

## Why this is a thin, gated step

- It **requires Cloudflare auth** (`wrangler login` / an API token). An automated agent may
  not have credentials — if not, this becomes a **human action**: surface the exact command
  and ask the operator to run it.
- It does **not** block the extension track. [03](./03-extension-foundation.md) uses a
  placeholder URL (`http://localhost:8787`) and the deployed URL is a one-line swap once
  known. So 02 can land at any point after 01 without holding anyone up.

## Steps

1. Confirm [task 01](./01-backend-data-model.md) is merged and `npm test` is green.
2. From `backend/`, deploy:
   ```bash
   npm run deploy        # → wrangler deploy
   ```
3. Capture the public URL wrangler prints (e.g. `https://backend.<subdomain>.workers.dev`).
4. **Smoke-test the live Worker** against the *remote* KV namespace (it starts empty):
   ```bash
   curl "https://<deployed-url>/?code=SMOKE-01"                 # → [] initially
   curl -X POST "https://<deployed-url>/?code=SMOKE-01" \
     -H 'Content-Type: application/json' \
     -d '{"clientId":"deadbeef","name":"smoke","videoId":"abc123","timestamp":42,"duration":100}'
                                                                # → {"ok":true}
   curl "https://<deployed-url>/?code=SMOKE-01"                 # → [ {…, "updatedAt": …} ]
   ```
5. Record the URL where the extension reads it: the single hardcoded constant
   `BACKEND_URL` in `extension/shared.js` (owned by
   [03 foundation](./03-extension-foundation.md)). If `shared.js` exists, update that line;
   if it does not exist yet, hand the URL to whoever runs task 03.

## Gotchas

- **Local vs remote KV:** the Worker has only been exercised against a *local* KV store
  (`wrangler dev` state in `.wrangler/`). After `wrangler deploy` the live Worker uses the
  *remote* `PROGRESS` namespace, which **starts empty** — don't be surprised by an empty GET.
- Re-run deploy after any backend change; the live URL stays the same across redeploys.
- The Friend Code is the only access control. Anyone with a code can read/write that pair's
  data. Acceptable for the MVP; don't present the deployed endpoint as secure.

## Acceptance criteria

- `wrangler deploy` succeeds and the public URL is captured.
- The live smoke test round-trips a Progress Record (POST then GET returns it with a
  server-set `updatedAt`).
- The URL is recorded in `extension/shared.js`'s `BACKEND_URL` (or handed to task 03).

## Next

Tell [03 foundation](./03-extension-foundation.md) the real URL so the placeholder can be
replaced. End-to-end verification happens once the extension consumer tasks
([04](./04-extension-popup.md)–[06](./06-extension-renderer.md)) are in.
