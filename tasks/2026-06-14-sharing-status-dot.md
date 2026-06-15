# Task: Replace the Sharing slider with a click-to-toggle status dot

> Status: defined (grilled), not started. Created 2026-06-14.

## Problem

The Sharing control is a large `.toggle-row` (label + "Share your watch progress
with your Buddy" hint + a slider-styled checkbox) that sits **outside**
`#view-connected` and shows always — even before a code exists. It is heavy chrome for
a binary, reversible setting, and it duplicates the popup's status idiom: there is
already a colored dot + text status block (`#status`) for pairing
(Unpaired / Waiting / In group / Group full).

## Goal

Collapse Sharing into the **existing pairing status dot** so the popup carries one
status indicator, not a status block *plus* a big toggle. The dot becomes a
click-to-toggle: solid = sharing, hollow = not sharing. No standalone switch.

## Locked decisions (from grilling)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Placement | **Merge into the pairing status line** (inside `#view-connected`). The single dot encodes both pairing color and sharing fill. No separate sharing chip. |
| 2 | Visibility when unpaired | **Hide it.** Sharing control renders only when a code is set (chooser/join views show no sharing UI). Sharing is a no-op without a code (reporter already bails on `!code`). |
| 3 | Representation | **One dot, two states.** Color = pairing (amber waiting / green in-group / dark full). Fill = sharing (**solid** on / **hollow** off). Suffix `· Not sharing` appended to the status text **only when off**; sharing-on stays quiet (no suffix). |
| 4 | Click target | **The dot itself.** It becomes a real focusable `<button>` (replaces the `#sharing` checkbox); Space/Enter toggle; `aria-pressed` reflects state. Small dot visually, padded ~28px hit area. |
| 5 | Affordance | **Padded hover-ring dot + tooltip.** Hover/focus → cursor pointer + ring/halo around the dot (reuse the `.switch input:focus-visible` ring) + native `title`. Tooltip/`aria-label` names the action: "Stop sharing" (on) / "Start sharing" (off). |
| 6 | Copy | **Not sharing / Stop / Start.** Off suffix `· Not sharing`. Tooltip on = "Stop sharing"; tooltip off = "Start sharing". |
| 7 | Stop confirm | **Confirm before stopping.** Clicking a solid dot opens a confirm dialog first. |
| 8 | Start | **Instant, no confirm.** Clicking a hollow dot resumes sharing on a single click. Asymmetric — only going dark needs guarding; opting back in has no downside. |
| 9 | Dialog | **Generalize the existing confirm-overlay** into one reusable `confirm({ title, body, confirmLabel, variant })`. Disconnect = `danger`/"Disconnect"; stop-sharing = `neutral`/"Stop sharing". |
| 10 | Locked (Group full) | **Read-only.** In the locked-out 6th state the dot is a passive dark indicator — no button, no ring, no tooltip. Toggle is interactive only in `waiting` + `in group`. |

## State table

| pairing | sharing | dot color | dot fill | status text | dot interactive? |
|---------|---------|-----------|----------|-------------|------------------|
| waiting | on | amber | solid | `Waiting for buddy` | yes |
| waiting | off | amber | hollow | `Waiting for buddy · Not sharing` | yes |
| in group | on | green | solid | `In group` | yes |
| in group | off | green | hollow | `In group · Not sharing` | yes |
| group full | — | dark | passive | `Group full` | **no (read-only)** |
| unpaired / no code | — | — | — | control hidden | n/a |

The `#status-sub` sub-line (`· N buddies`) and roster are unchanged.

## Interaction

- Dot is the toggle: a real focusable `<button>` replacing the `#sharing` checkbox.
  Space/Enter activate; `aria-pressed` = sharing state; `aria-label` = the action verb.
- Hover/focus → cursor pointer + ring/halo (reuse `.switch input:focus-visible`) +
  native `title` tooltip ("Stop sharing" / "Start sharing").
- Interactive only in `waiting` + `in group`. In `Group full` the dot is passive (no
  button, ring, or tooltip). Hidden entirely when unpaired.

### Stop vs start (asymmetric confirm)

- **Stopping** (solid → off): opens the confirm dialog.
  Proposed copy — title `Stop sharing?`, body `Your Buddy won't see your progress
  until you start again.`, confirm button `Stop sharing` (neutral, **not** danger).
  (Body wording is the one open item — tweak freely.)
- **Starting** (off → solid): instant single click, no dialog.

## Dialog refactor

Generalize `#confirm-overlay` into one reusable
`confirm({ title, body, confirmLabel, variant })`:

- Rename `pendingDisconnect` → `pendingConfirm`; the confirm button's label + color
  (`danger` vs `neutral`) set per-open.
- Disconnect (Change code / Re-roll) keeps `variant: 'danger'`, label `Disconnect`,
  via `confirmDisconnectThen` (which now routes through the generalized `confirm`).
- Stop-sharing uses `variant: 'neutral'`, label `Stop sharing`.
- One overlay component, two callers — no duplicated markup/CSS.

## Files

- `extension/popup.html` — remove `.toggle-row` markup + hint + `.switch`/`.slider`
  CSS + `#sharing` checkbox; add dot-button styling (ring, hollow/solid fill, hit
  area); add a `variant`/neutral-button style to the confirm dialog.
- `extension/popup.js` — wire the dot button (toggle + tooltip/`aria-pressed`),
  generalize `confirm()` and `pendingDisconnect` → `pendingConfirm`, fold the
  sharing fill + `· Not sharing` suffix into `setStatus`/`refreshStatus`, drop the
  `el.sharing` change handler.
- No backend, no `shared.js`/`reporter.js` logic changes.

## Removals

- `.toggle-row` markup + the "Share your watch progress with your Buddy" hint.
- `.switch` / `.slider` CSS and the `#sharing` checkbox.
- The `el.sharing.addEventListener("change", …)` wiring (moves to the dot button).

## Unchanged behavior (must stay true)

- `sharing` defaults `true` (`shared.js`); the config schema is untouched.
- Reporter still bails on `!sharing || !code`; the renderer still draws the Buddy's
  markers when you are off — stopping only halts **your** POSTs.
- Old Progress Records expire via the backend's 14-day TTL; pairing is never dropped
  by toggling sharing.

## Acceptance criteria

1. No standalone Sharing toggle / slider / hint anywhere in the popup.
2. Connected + sharing → solid colored dot, no suffix, tooltip "Stop sharing".
3. Click solid dot → "Stop sharing?" confirm → on confirm the dot goes hollow +
   `· Not sharing`; the reporter stops POSTing.
4. Click hollow dot → resumes instantly (no dialog); dot solid, POSTs resume.
5. Dot is keyboard-operable (Tab to it, Space/Enter toggle) with a visible focus ring
   and correct `aria-pressed`.
6. `Group full` → dark passive dot, not clickable; unpaired/chooser/join → no sharing
   control.
7. Disconnect confirm (Change code / Re-roll) still works, still red/"Disconnect",
   via the now-shared dialog.

## Non-goals

- Any change to `sharing` semantics (still default-on; off = stop my POSTs only).
- Backend, `shared.js`, or `reporter.js` logic changes.
- A second sharing indicator or chip outside the pairing line.
- Pre-pairing (unpaired) sharing control.

## Test plan

- Extension popup is manual (no harness): drive the 7 acceptance criteria in the
  loaded extension against the local worker — toggle stop (with confirm) / start
  (instant), keyboard operation, and the `Group full` / unpaired hidden cases.
- Confirm the disconnect flow (Change code / Re-roll) still triggers the red dialog
  after the `confirm()` generalization.
