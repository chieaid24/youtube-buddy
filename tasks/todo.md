# Batch: work through all 7 defined tasks

Order chosen to minimize `popup.js`/`shared.js` conflict churn; rename last so its grep-gate cleans up strings the others introduce.

- [x] 1. unnamed-buddy-fallback — backend name optional + `buddyName()` helper ✅ merged
- [ ] 2. cute-codes-copy-button — 2-word codes, pretty display, copy button
- [ ] 3. display-name-blur-save — drop Save, pencil edit icon
- [ ] 4. themeable-buddy-color-palettes — `PALETTES` map + picker
- [ ] 5. sharing-status-dot — dot toggle, generalize confirm dialog
- [ ] 6. group-presence-membership — presence endpoints, `presence.js`, poll/toast
- [ ] 7. rename-friend-code-to-room-code — ubiquitous-language pivot (LAST)

Flow per task: implement in worktree → verify (backend `npm test`, JS `node --check`, grep gates) → commit → mark task done + update docs → merge branch→main.

Verification limit: no live Chrome/YouTube harness in this job; extension ACs needing a browser are code-reviewed against spec, not browser-proven.
