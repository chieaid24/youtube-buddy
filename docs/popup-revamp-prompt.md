# Popup revamp — agent prompt

Hand this to an agent to redesign the YouTube Buddy action popup. Pairs with the
design system in [`DESIGN.md`](../DESIGN.md) at the repo root.

---

Completely redesign the visual UI of the YouTube Buddy browser-extension
action popup — the panel that opens when you click the extension's toolbar
icon. This is a UI/UX revamp: the core behavior and every flow must survive,
but you have wide creative latitude over HOW it looks and is structured.
Nothing about the notes feature, the on-video progress-bar markers, or the
feed thumbnail bars is in scope.

## Source of truth for the look: DESIGN.md

Read `DESIGN.md` at the repo root FIRST and treat it as the design system:
the soft-apricot OKLCH palette, the bundled rounded font (Nunito, base64
woff2), the space/radius/elevation tokens, the gentle-with-subtle-spring
motion choreography, warm dark mode, and the "warm but typographic, no
mascots" personality. Implement that system. (The impeccable context loader
will also surface it automatically.) Where DESIGN.md and this prompt agree,
follow them; where DESIGN.md leaves something "open for implementation to
tune," use your judgment.

## Creative liberty

Within the design system, you have real freedom. You may restructure the DOM,
rename IDs, change the layout, rethink how a control is presented (e.g. the
sharing toggle as a pill vs inline word, how the roster reads, how views
transition), add tasteful polish and micro-interactions, and reorganize
popup.js however produces the best result. Do not feel bound to the current
markup. The ONE hard rule: **keep the core functionality intact** (every flow
in the inventory below still works, with equivalent behavior). Make it as good
as you can; iterate against real screenshots until it's genuinely polished.

## Scope — touch ONLY these files

- extension/popup.html (markup + all styling; CSS is inline in a <style> block)
- extension/popup.js (wiring/logic — restructure freely; preserve behavior
  and the contract call-sequences below)

## Do NOT touch (out of scope, will break other surfaces)

- extension/renderer.js, composer.js, content.js, reporter.js, presence.js
- extension/shared.js (window.YTB) — READ-ONLY contract
- extension/room-code.js (window.YTBRoomCode) — READ-ONLY contract; the backend
  test suite depends on its exported API. Consume it,
  never change it.

## Hard constraints (Chrome MV3, no build step)

- popup.html loads three scripts in order: shared.js, room-code.js, popup.js.
  Files load directly — no bundler, no npm build. Keep it that way.
- Strict CSP: NO external resources. No CDN, no web fonts over the network, no
  remote images, no fetch for assets. Inline ALL CSS, ALL SVG icons, and the
  base64 font. Anything you add is self-contained in popup.html/popup.js.
- ASCII-only in source and UI copy. No em dashes in copy.
- Support light + warm dark mode via prefers-color-scheme; meet WCAG AA in both.

## Functional inventory — ALL of this must still work

State persists in chrome.storage.local via YTB. Preserve every flow:

1. Nickname: editable field that locks to a value chip with a pencil edit
   affordance once set; fresh install (blank) opens editable; persists each
   keystroke; commits on Enter/blur; re-asserts presence on commit.
2. Room Code, three mutually-exclusive views:
   - Chooser: primary "Create a room" + secondary "Join a room"; create-error
     line; a "Cancel" link shown only when a code already exists.
   - Join: free-text code input, a "Join" button disabled until input, an inline
     "This room doesn't exist yet" error, a "Back" link.
   - Connected: the active code as its pretty label (YTBRoomCode.pretty), a copy
     button with the copy->check crossfade + "Copied!"/"Could not copy"
     feedback, the room-status block, the roster, the color picker, and a red
     "Leave room" button.
3. Room status states: Unpaired, "Waiting for buddies", In room (roster),
   "Room full" (locked out at MAX_MEMBERS).
4. Sharing toggle: stop -> confirm dialog; start -> instant; clear on/off visual.
5. Buddy roster: per-row swatch + name + relative last-seen ("just now",
   "5m ago", "2h ago", "3d ago"); doubles as the on-video marker color legend.
6. Per-buddy color picker: swatch click opens a popover of YTB.BUDDY_COLORS;
   colors used by other buddies disabled; pick -> YTB.setBuddyColor + re-render;
   dismiss on outside-click/Escape; anchors to the swatch and flips above when
   there's no room below.
7. Reusable confirm dialog (NOT window.confirm): danger ("Leave") and neutral
   ("Stop sharing") variants; dismiss via Cancel/backdrop/Escape.
8. Footer: backend URL (YTB.BACKEND_URL).

## Data contracts you must keep calling (do not reinvent networking)

window.YTB: BACKEND_URL, ensureClientId, getConfig, setConfig, getRecords,
roomView, roomExists, normalizeCode, assertPresence, deleteMember,
syncBuddyColors, buddyColor, buddyName, setBuddyColor, clearRoomColors,
MAX_MEMBERS, BUDDY_COLORS, _buddyColors.
window.YTBRoomCode: generate, generateAvailable, pretty, copy, CheckFailedError.
Read the current popup.js end to end before rewriting so no side effect is
dropped. Per-flow, the sequence of YTB/YTBRoomCode calls must stay equivalent to
today's (e.g. create = generateAvailable -> setConfig -> deleteMember/
clearRoomColors on old code -> assertPresence -> refreshStatus).

## Visual verification with Playwright (iterate against real pixels)

Set up Playwright locally to SEE every change and refine it. NOTE: per ADR-0001
this extension has no background service worker, so the "get the extension id
from the service worker" trick does not apply. Use this two-tier approach:

TIER 1 — fast visual loop (primary; use this to iterate on design):
Render popup.html directly under a stubbed environment so every state is
deterministic and screenshottable, with no Chrome extension install needed.

- `npm i -D playwright && npx playwright install chromium`.
- Serve the extension/ dir with a tiny static server (or use file://), then in a
  page injected BEFORE the three scripts, shim what shared.js needs:
  - a minimal `window.chrome.storage.local` (get/set/remove over an in-memory
    object) so YTB.getConfig/setConfig work;
  - a stub for the backend read so states are canned: after scripts load, wrap
    or replace `window.YTB.getRecords` to return a chosen `{ok, progress,
presence}` shape, OR intercept the fetch to BACKEND_URL via
    `page.route(...)`. This lets you force: unpaired, waiting (empty room),
    in-room with 1..N named buddies at varied last-seen ages, and room-full
    (MAX_MEMBERS other members).
- For each state, screenshot BOTH themes with
  `page.emulateMedia({ colorScheme: 'light' | 'dark' })`, and also capture a
  `prefers-reduced-motion: reduce` pass to confirm motion degrades. Screenshot
  the transient beats too (copy->check, color-grid open, confirm dialog,
  new-buddy row-in). Keep a throwaway harness + screenshots under a temp dir;
  do not commit the harness.
- Look hard at each screenshot: spacing, alignment, contrast, the code label as
  hero, focus rings, truncation of long names/codes. Fix and re-shoot until it's
  genuinely polished, not just functional.

TIER 2 — real-extension smoke test (final gate, once):
Start the backend (invoke /start-dev), load extension/ unpacked in real Chrome
(chrome://extensions -> Developer mode -> Load unpacked) against the running
wrangler dev on :8787, and walk the TRUE flows once end to end: onboarding,
create room, join nonexistent (error) + real room, copy, waiting, a buddy
appears, change a buddy color, room-full lockout, stop/start sharing (with
confirm), leave room (with confirm). Confirm zero console errors in the popup
(right-click popup -> Inspect).

## Done means

- DESIGN.md system implemented; both themes AA; reduced-motion honored.
- All 8 flows verified in Tier-1 screenshots AND the Tier-2 real-extension walk.
- `cd backend && npm test` still green (room-code.js contract untouched).
- Final light + dark screenshots of every state attached to your report.
