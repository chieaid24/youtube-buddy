---
name: Agent task
about: A tracer-bullet slice an agent (Claude Code or Codex CLI) can complete autonomously
title: ''
labels: ready
---

## Parent

<!-- Reference to the parent PRD or tracking issue (omit if standalone). -->

## What to build

<!-- Concise end-to-end description of this slice. Describe behavior, not layer-by-layer implementation.
     Avoid specific file paths - they go stale fast. Exception: if a prototype produced a snippet that
     encodes a decision more precisely than prose (state machine, schema, type shape), inline it and
     note it came from a prototype. -->

## Type

<!-- AFK - fully autonomous: implement, test, and merge without human involvement (preferred)
     HITL - requires human interaction: architectural decision, design review, or external dependency -->

## Acceptance criteria

- [ ]

## Blocked by

<!-- True logical blockers only ("needs A's code to exist"), set as native GitHub `blocked-by`
     edges - those are authoritative. List here for humans, e.g. "blocked by #12".
     "None - can start immediately" if no blockers. -->

## Definition of done

- [ ] CI `test` check green
- [ ] Verified locally if runtime behavior or UI changes
- [ ] PR opened on branch `ytb/<issue#>-<slug>` with `Closes #<this issue>`

## Notes / context

<!-- Links to PRD.md sections, docs/adr/*, related issues. -->
