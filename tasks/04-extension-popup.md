# Task 04 — Extension: popup (identity, codes, pairing status, Sharing toggle)

> Part of the [task breakdown](./INDEX.md). Track: **extension**. Depends on:
> [03 foundation](./03-extension-foundation.md) (Contract B — `window.YTB`). Runs in parallel
> with [05 reporter](./05-extension-reporter.md) and [06 renderer](./06-extension-renderer.md)
> — disjoint files, no collisions.

## Goal

Build the action popup: the only UI surface for identity, pairing, and the Sharing switch.
PRD plan-of-record step 4 (popup half).

## Files you own

- `extension/popup.html`
- `extension/popup.js`

Do **not** edit `shared.js`, `content.js`, `reporter.js`, `renderer.js`, or `manifest.json`
(the popup is already wired into the manifest by [task 03](./03-extension-foundation.md)).

## What the popup must do (from the PRD)

- **Display Name input** — persist to `name`. Cosmetic only; identity is the Client ID.
- **Friend Code:**
  - A **"Generate code"** button — client-side only, e.g. a random word + 2 digits like
    `WOLF-42`. (Pick a small built-in word list.)
  - An **"Enter code"** input to join an existing one. **Normalize to uppercase** via
    `YTB.normalizeCode` before saving so `wolf-42` and `WOLF-42` pair.
  - Persist to `code`.
- **Pairing status — three states** (see logic below):
  - *Unpaired* — no code set.
  - *Waiting for buddy* — code set, but no record from another Client ID under the code.
  - *Paired* — a foreign-`clientId` record exists; show the **Buddy's Display Name** and
    **last-seen time** (from that record's `updatedAt`).
- **Sharing toggle** — persist boolean `sharing`. When off, the content-script reporter stops
  POSTing but the renderer keeps fetching/showing the Buddy's markers (the reporter in
  [task 05](./05-extension-reporter.md) reads this flag; the popup only writes it).
- **Show the configured backend URL** — read `YTB.BACKEND_URL` and display it (read-only).

All persisted state lives in `chrome.storage.local` and must **survive browser restart**.

## Contracts you consume (frozen in [task 03](./03-extension-foundation.md))

From `window.YTB` (loaded via `<script src="shared.js"></script>` **before**
`<script src="popup.js"></script>` in `popup.html`):

```js
YTB.BACKEND_URL                       // string, for display
await YTB.getConfig()                 // → { name, code, clientId, sharing }
await YTB.setConfig({ name?, code?, sharing? })
await YTB.ensureClientId()            // → clientId (generate-once); call on popup open
await YTB.getRecords(code)            // → Array<ProgressRecord>
YTB.normalizeCode(raw)                // → uppercased/trimmed code
YTB.formatTime(seconds)              // (not needed here; tooltip util)
```

**`ProgressRecord`**:
`{ clientId, name, videoId, timestamp, duration, updatedAt }`.
A record is the **Buddy's** iff `record.clientId !== myClientId`.

> Confirm in `shared.js` whether `getRecords` takes the code as an argument (it should — the
> popup has the code). If task 03 chose differently, follow what `shared.js` actually exposes.

## Pairing-status logic

```
config = await YTB.getConfig()
myClientId = await YTB.ensureClientId()

if (!config.code)            → "Unpaired"
else:
  records = await YTB.getRecords(config.code)
  buddyRecords = records.filter(r => r.clientId !== myClientId)
  if (buddyRecords.length === 0) → "Waiting for buddy"
  else:
    buddy = buddyRecords with the max updatedAt
    → "Paired" — show buddy.name and last-seen = formatted(buddy.updatedAt)
```

The popup recomputes status when it opens (and may re-poll while open, but a single fetch on
open satisfies the PRD). A popup has no long lifetime — no need for intervals.

## Steps

1. `popup.html` — minimal markup: Display Name field, "Generate code" button + "Enter code"
   input, a status line, a Sharing toggle (checkbox/switch), and a read-only backend-URL line.
   Include `shared.js` then `popup.js` as `<script>` tags.
2. `popup.js` — on open: `ensureClientId()`, `getConfig()`, populate fields, compute and
   render pairing status. Wire change handlers to `setConfig`. "Generate code" produces a
   `WORD-NN` code, fills the input, and saves it (normalized).
3. Verify against the acceptance criteria below in a loaded extension.

## Gotchas

- **No build step** — plain HTML/JS/CSS loaded directly. Keep it dependency-free.
- **Display Name collisions are harmless** — identity is the Client ID. Don't dedupe names.
- The Friend Code is a weak secret; don't present it as secure (it gates read+write for the
  pair). No copy implying security.
- Use the [glossary](../CONTEXT.md) terms in UI copy: "Friend Code", "Buddy", "Paired",
  "Waiting for buddy", "Unpaired", "Sharing", "Display Name".

## Acceptance criteria

- Entering a Display Name + a code, closing and reopening the popup (and restarting the
  browser) preserves them, `clientId`, and the `sharing` flag (`chrome.storage.local`).
- "Generate code" yields a `WORD-NN`-style Friend Code; "Enter code" normalizes to uppercase.
- With a code set but no Buddy yet → **Waiting for buddy**. Once a foreign-`clientId` record
  exists under the code → **Paired** with the Buddy's Display Name + last-seen time.
- The Sharing toggle writes `sharing` to storage (its effect on POSTing is verified in
  [task 05](./05-extension-reporter.md)).
- The backend URL is displayed.

## Related

- [03 foundation](./03-extension-foundation.md) — the `YTB` contract you build on.
- [05 reporter](./05-extension-reporter.md) — reads the `sharing` flag you write.
- [CONTEXT.md](../CONTEXT.md) — terminology for UI copy.
