# Room Home is a floating overlay panel, not embedded in the home grid

The Shared Playlist and Room Feed need a home surface. The action popup was rejected early (it is transient, Chrome-positioned, and small, while the Feed and Recommendations are ambient browsing surfaces); the surface lives on YouTube's home route instead, as the **Room Home Panel**.

It first shipped **embedded**: a `<section>` inserted directly above the recommendations grid (`ytd-rich-grid-renderer`), which YouTube's own layout then pushed down. That embedding was the mistake this ADR corrects. It made the panel a hostage of YouTube's layout DOM twice over — the grid insertion point plus the guide-row toggle in `ytd-guide-renderer` — so it shifted the grid, had to re-inject after every SPA navigation, and broke whenever YouTube reshaped its home markup. It also forced a wide, horizontal Feed-left / Recommended-right layout to avoid pushing the grid too far down.

## Decision

Room Home renders as a **floating overlay panel**, not part of YouTube's layout flow. The panel is a `position: fixed` element appended to `<body>` over a slightly-dim scrim; it reads **no** YouTube layout DOM. The only remaining YouTube-DOM touch is the opener — the Room Home Toggle row still injected into the left guide — which is deliberately isolated to one module.

Concretely:

- **Left-docked and portrait.** The panel pins to the left edge, beside the guide, roomy (about 440px) rather than thin, `max-height` about 80vh with its own internal scroll. Feed stacks **above** Recommended — the floating panel is free to be vertical, so it no longer forces the horizontal split the embedded band needed.
- **Ephemeral, opened on demand.** The Room Home Toggle **opens** the panel; the panel's close control, a scrim click, Esc, or an SPA navigation all close it. There is no persisted visibility preference — the old `homeSectionHidden` is retired and its popup Settings toggle removed. The toggle reflects the live open state.
- **The scrim blocks, and that is accepted.** A slightly-dim scrim covers the page while the panel is open, catching outside clicks to close. Because the panel is opened deliberately and dismisses on navigation, the page is never left blocked by accident.

This is consistent with **ADR-0001**: the content script owns all on-page rendering, there is no background service worker, and `content.js` remains the sole navigation/DOM observer. The panel is one more pure consumer of `ytb:navigate` / `ytb:room-data`, and the toggle and panel coordinate open/close purely through in-page CustomEvents — no storage round-trip, since both are content-script modules in the same page.

Longer term, this panel is the shell that will absorb the identity / Room / Settings controls currently in the action popup, consolidating the extension into a single in-page Control Panel hub. Building it as a floating shell now is what makes that consolidation possible without another layout fight.

## Consequences

- The panel's own rendering no longer depends on YouTube's home DOM at all — the biggest fragility of the embedded version is gone. Only the guide-row opener still targets YouTube markup, and that is contained to one module and retried on `ytb:mutation`.
- Visibility is no longer persisted. The three former writers of `homeSectionHidden` (guide row, section header close, popup Settings) collapse to two ephemeral controls (guide row opens, panel close/scrim/Esc/navigation closes) coordinating by CustomEvent; the popup loses its Room Home toggle and its `homeSectionHidden` storage seam.
- The panel blocks the page while open. This is a real behavior change from the embedded band (which was non-blocking) and is the deliberate price of a focused, floating surface opened on demand.
- Unpaired users still get a compact Create / Join prompt inside the panel — a second entry point to Room setup beyond the popup; both must stay behaviorally consistent (reuse the same `YTB` / `YTBRoomCode` calls).
- The Feed is still derived entirely on the client from the existing Room read plus Playlist Events, so this surface adds **no** new read fan-out or per-recipient storage.
