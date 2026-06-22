# Task: Rename "Friend Code" → "Room Code" and "Group" → "Room"

Status: **DONE** 2026-06-21. Full ubiquitous-language pivot Friend Code→Room Code, Group→Room across extension copy + comments + identifiers (`groupView`→`roomView`, `is-ingroup`→`is-inroom`, `change-code`/`el.changeCode`→`leave-room`/`el.leaveRoom`), backend (`"group full"`→`"room full"` + comments + tests), CONTEXT.md, ADR-0002. CLAUDE.md updated separately (it is gitignored, primary-only). Mechanism identifiers (`?code=`, KV keys, `code`/`codeOrigin`, `normalizeCode`) and the internal "disconnect" names kept.
Date: 2026-06-14

Pivot the ubiquitous language from **Friend Code / Group** to **Room Code / Room**.
This reverses the language deliberately documented in `CONTEXT.md` and `ADR-0002`
(which currently list `room` / `room code` under `_Avoid_`).

## Decisions locked (from grilling)

| # | Decision |
|---|----------|
| Scope | **Full ubiquitous-language**: visible copy + comments + internal identifiers + docs + backend JSON + tests |
| Status labels | `In group`→`In room`, `Group full`→`Room full`, `Waiting for buddy`→**`Waiting for buddies`** (a room implies >1); `Unpaired` kept; the buddy/buddies count logic in sub-text kept |
| Create/join flow | `Create a code`→`Create a room`, `Join a friend`→`Join a room`, placeholder `friend's code`→`room code`, sub-text `…Friend Code to pair.`→`…Room Code to join.` (**verb pair→join**); `Join`/`Back`/`Cancel` unchanged |
| Leave cluster | `Change code`→`Leave room`; dialog (no buddy) `Change your Friend Code?`→`Leave this room?` + body→`No buddy has joined this room yet.`; dialog (buddies) body→`This will remove you from the room, away from: X` (buddy-present **title unchanged**); confirm button `Disconnect`→`Leave`; `Re-roll` unchanged |
| Mechanism | **Display term only** — `?code=`, KV key `{code}:{clientId}:{videoId}`, config `code`/`codeOrigin`, `normalizeCode()` all **untouched** (non-breaking, no migration) |
| share/ | **Frozen — untouched** |
| ADR | **Rewrite ADR-0002 in place** (Group→Room, title→"Rooms of up to five…"); keep filename slug; no new ADR |
| PRD.md | **Untouched** (historical MVP spec, already stale vs ADR-0002) |

## New ubiquitous language (canon)

- **Room Code** = the shared string (was Friend Code)
- **Room** = the set of people sharing a Room Code, ≤5 (was Group)
- **Room states**: Unpaired / Waiting / In room / Room full (was Group states)
- **Buddy / Buddies**: unchanged · the verb is **join** (not pair)

## Files in scope (11)

### UI copy & logic

- `extension/popup.html` — title label `Friend Code`→`Room Code`; `Create a code`→`Create a room`;
  `Join a friend`→`Join a room`; placeholder `friend's code`→`room code`; button `Change code`→`Leave room`
  + `id="change-code"`→`leave-room`; confirm button `Disconnect`→`Leave`; CSS `.status.is-ingroup`→`.is-inroom`;
  affordance comments. *(Leave `.is-paired` and the `Unpaired` label as-is.)*
- `extension/popup.js` — `el.changeCode`→`el.leaveRoom` + `getElementById("leave-room")`;
  status state `"ingroup"`→`"inroom"` + label `In group`→`In room`; `Group full`→`Room full`;
  `Waiting for buddy`→`Waiting for buddies`; sub-text `…Friend Code to pair.`→`…Room Code to join.`;
  dialog copy per the leave-cluster row (and drop the now-unused buddy/buddies `label` var in that body);
  `groupView`→`roomView` (call sites); all "Friend Code"/"Group" comments.
  *(Keep `pendingDisconnect`, `confirmDisconnectThen`, `clearCodeAndChoose`, `id="confirm-disconnect"` —
  "disconnect" is not part of the rename.)*
- `extension/shared.js` — `groupView()`→`roomView()` (definition); all "Friend Code"/"Group" comments + JSDoc.
- `extension/renderer.js` — `YTB.groupView`→`YTB.roomView`; comments.
- `extension/reporter.js` — one comment.
- `extension/manifest.json` — description `…via a Friend Code.`→`…via a Room Code.`

### Backend

- `backend/src/index.ts` — `json({ error: "group full" })`→`"room full"`; 3 comments.
- `backend/test/index.spec.ts` — `describe("Group cap")`→`"Room cap"`; test names + `expect(...).toEqual({ error: "room full" })`.

### Docs

- `CONTEXT.md` — rename **Friend Code**→**Room Code** entry, **Group**→**Room** entry, **Group states**→**Room states**;
  invert the `_Avoid_` lines (room/group become the avoided terms, friend-code retired); fix in-prose
  "Group"→"Room" (lines 3, 20, 28).
- `docs/adr/0002-groups-of-up-to-five.md` — rewrite Group→Room, title→"Rooms of up to five; best-effort
  membership cap"; keep the filename slug.
- `CLAUDE.md` — lines 7, 9, 17, 22: `Friend Code`→`Room Code`, `pairing status`→`room status`,
  glossary `Paired`→`Room states`.

## Out of scope (explicit)

`share/**` · `PRD.md` · `README.md` (empty stub) · mechanism identifiers (`?code=`, KV keys, `code`/`codeOrigin`,
`normalizeCode`) · `pendingDisconnect`/`confirm-disconnect`/`clearCodeAndChoose` internal "disconnect" names ·
`Unpaired` label / `.is-paired` CSS · `worker-configuration.d.ts` `console.group`.

## Verification loop

1. `cd backend && npm test` → green (11 tests) after the `"room full"` swap.
2. Grep gate: `grep -riE "friend code|in group|group full|change code|join a friend|create a code|waiting for buddy" extension/ backend/ CONTEXT.md docs/ CLAUDE.md` → **no hits**.
3. Load extension unpacked; confirm popup: title **Room Code**; chooser **Create a room** / **Join a room**;
   join placeholder **room code**; connected view **Leave room**; status cycles
   **Unpaired → Waiting for buddies → In room / Room full**.
4. Leave-room dialog: no-buddy → "Leave this room?" / "No buddy has joined this room yet.";
   with buddies → body "This will remove you from the room, away from: …", confirm button **Leave**;
   Re-roll still mints a new code.

## Review

- **Backend** (`index.ts` + tests) — `"group full"`→`"room full"` (both POST paths), all "Group"/"Friend Code" comments → "Room"/"Room Code"; test describe/it names + expectations updated. `npm test` green (**28 tests**, not the spec's stale 11).
- **Extension copy** — popup.html: `Friend Code`→`Room Code` label, `Create a code`→`Create a room`, `Join a friend`→`Join a room`, placeholder `room code`, `Change code`→`Leave room` (+ `id="leave-room"`), `.is-ingroup`→`.is-inroom`, confirm default `Leave`. popup.js status: `In group`→`In room`, `Group full`→`Room full`, `Waiting for buddy`→`Waiting for buddies`, sub-text → "…Room Code to join.", dialog copy per the leave-cluster row (dropped the now-unused buddy/buddies `label` var), confirm label `Disconnect`→`Leave`. manifest description → `Room Code`.
- **Identifiers** — `YTB.groupView`→`YTB.roomView` (shared.js def + renderer.js + popup.js callers); status state `ingroup`→`inroom`; `el.changeCode`→`el.leaveRoom` + `getElementById("leave-room")`. Mechanism identifiers (`?code=`, KV keys, `code`/`codeOrigin`, `normalizeCode`) and internal `pendingDisconnect`/`confirm-disconnect`/`clearCodeAndChoose` names **kept** per spec; `Unpaired`/`.is-paired` kept.
- **Docs** — CONTEXT.md: Room Code / Room / Room states entries, inverted `_Avoid_` lines (friend-code/group now avoided). ADR-0002 rewritten in place (title "Rooms of up to five…"; also refreshed the now-stale GET-shape / `roomView` / presence-counts-toward-cap facts). CLAUDE.md (gitignored, primary-only) updated post-merge with the full end-state (endpoints, presence, load order, terminology, test count).
- **Verification** — grep gate clean on tracked files (only the deliberate `_Avoid_: friend code` line in CONTEXT.md remains, which is correct); `node --check` clean on all extension JS; no orphan `change-code`/`groupView`/`ingroup` references. Step 3/4 (live popup) code-reviewed against the markup/handlers; no live-browser harness in this job. (Re-roll referenced in the spec was already removed by the cute-codes task.)
- *Note: the rename spec's grep pattern `waiting for buddy` substring-matches the new `waiting for buddies`; used a `\b`-anchored variant to confirm no singular remains.*
