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

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Only touch what's necessary. No side effects with new bugs.

## Project Rules

- Before executing anything on non-trivial tasks, ask the user clarification questions. For clear bug reports, just fix them autonomously.
- DON'T add project secrets to the README.md.
- Follow all existing code patterns in the codebase when writing new code.
- ALWAYS inform the user when making changes that were not explicitly requested. If a change is implied or necessary but not directly asked for, call it out before or after making it.
- ALWAYS verify with real logs and real data values before executing anything. Never assume container names, field names, or data formats — check them first.
- NEVER add Co-Authored-By lines or any AI attribution to git commits. All commits should appear as solely authored by the user.

## Workflow Orchestration

### Plan Mode
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions).
- Write detailed specs upfront to reduce ambiguity.
- If something goes sideways, stop and re-plan immediately.
- Use plan mode for verification steps, not just building.

### Subagent Strategy
- Use subagents liberally to keep the main context window clean.
- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.

### Self-Improvement Loop
- After any correction from the user: update `tasks/lessons.md` with the pattern.
- Write rules that prevent the same mistake from recurring.
- Review lessons at session start for relevant context.

### Verification Before Done
- Never mark a task complete without proving it works.
- Diff behavior between main and your changes when relevant.
- Ask: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness.

### Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: implement the elegant solution instead.
- Skip this for simple, obvious fixes — don't over-engineer.

### Autonomous Bug Fixing
- When given a bug report: just fix it. Point at logs, errors, and failing tests — then resolve them.
- Zero context switching required from the user.
- Go fix failing CI tests without being told how.

## Task Management

1. **Plan First**: Write a plan to `tasks/todo.md` with checkable items.
2. **Verify Plan**: Check in with the user before starting implementation.
3. **Track Progress**: Mark items complete as you go.
4. **Explain Changes**: High-level summary at each step.
5. **Document Results**: Add a review section to `tasks/todo.md` when done.
6. **Capture Lessons**: Update `tasks/lessons.md` after any corrections.


## Notes

- Tests run inside the Workers runtime via `defineWorkersConfig` (`vitest.config.mts`), so `cloudflare:test` provides `env` (with real KV bindings from wrangler.jsonc) and `SELF` for integration-style fetches.
- `backend/test/index.spec.ts` is still the unmodified "Hello World" template and does not match the current worker — expect it to fail until rewritten.
- After adding/changing bindings in `wrangler.jsonc`, run `npm run cf-typegen`; the `Env` interface in `src/index.ts` is currently hand-written and must be kept in sync with the bindings.
