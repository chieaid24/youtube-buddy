---
name: Agent task
about: A tracer-bullet slice an agent (Claude Code or Codex CLI) can complete autonomously
title: ''
labels: ready, afk
---

<!-- Autonomy is a label, not a body field — exactly one of the two. This template applies `afk`:
     fully autonomous, no human involvement (preferred). Swap it for `hitl` when a human's judgement
     gates the slice (architectural decision, design review, external dependency); `/start-next-issue`
     skips `hitl`, so a human picks it up. -->

## Parent

<!-- Reference to the parent PRD or tracking issue (omit if standalone). -->

## What to build

<!-- Concise end-to-end description of this slice. Describe behavior, not layer-by-layer implementation.
     Avoid specific file paths — they go stale fast. Exception: if a prototype produced a snippet that
     encodes a decision more precisely than prose (state machine, schema, type shape), inline it and
     note it came from a prototype. -->

## Acceptance criteria

- [ ]

## Blocked by

<!-- True logical blockers only ("needs A's code to exist"), set as native GitHub `blocked-by`
     edges — those are authoritative. List here for humans, e.g. "blocked by #12".
     "None — can start immediately" if no blockers. -->

## Definition of done

- [ ] CI `test` check green
- [ ] Verified locally if runtime behavior or UI changes
- [ ] Frontend/UI changes conform to `DESIGN.md`
- [ ] PR on branch `<issue#>-<slug>` with `Closes #<this issue>`

## Notes / context

<!-- Links to specs, ADRs, related issues. If this issue is labelled `hitl`, say exactly what human
     input it needs and who can give it — otherwise whoever picks it up has to work that out. -->
