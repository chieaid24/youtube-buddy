# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

youtube-buddy is a watch-progress sync service. The only code so far lives in `backend/`: a single Cloudflare Worker (`backend/src/index.ts`) backed by a KV namespace (`PROGRESS` binding, configured in `backend/wrangler.jsonc`).

The worker exposes one endpoint keyed by a `?code=` query param (a shared room/group code):

- `POST /?code=X` — body `{ name, videoId, timestamp }`; stores progress under KV key `"{code}:{name}"` with an added `updatedAt`.
- `GET /?code=X` — lists all participants' progress for that code (KV prefix scan on `"{code}:"`).
- CORS is wide open (`*`) since browser clients (e.g. an extension or userscript) call it directly.

## Commands

All commands run from `backend/`:

```bash
npm run dev        # local dev server via wrangler (state persisted in .wrangler/)
npm test           # vitest with @cloudflare/vitest-pool-workers (runs in workerd)
npx vitest run -t "name"   # run a single test by name
npm run deploy     # wrangler deploy to Cloudflare
npm run cf-typegen # regenerate worker-configuration.d.ts after changing wrangler.jsonc bindings
```

## Git conventions

- Never add `Co-Authored-By` or any AI attribution lines to commits — all commits must look like they came from the repo owner.
- Commit frequently in small, logical units; more commits is better than fewer.
- Never push unless explicitly told to.

## Notes

- Tests run inside the Workers runtime via `defineWorkersConfig` (`vitest.config.mts`), so `cloudflare:test` provides `env` (with real KV bindings from wrangler.jsonc) and `SELF` for integration-style fetches.
- `backend/test/index.spec.ts` is still the unmodified "Hello World" template and does not match the current worker — expect it to fail until rewritten.
- After adding/changing bindings in `wrangler.jsonc`, run `npm run cf-typegen`; the `Env` interface in `src/index.ts` is currently hand-written and must be kept in sync with the bindings.
