# Room Home Section is injected into the YouTube home page, not the action popup

The Shared Playlist and Room Feed need a home surface. Two options were on the table: (a) extend the existing action popup, which is already the identity / Room-management surface; or (b) inject a compact section into YouTube's own home page, above the recommendations grid. We chose (b): the **Room Home Section**.

The Shared Playlist and the Room Feed are ambient, browsing-time surfaces. You want them exactly where you decide what to watch next — the home grid — not hidden behind a toolbar click that most users open only to change settings. Surfacing them there makes "what are my Buddies queuing / saying" a passive part of the home page rather than an action you must remember to take. The popup stays focused on identity, the Room Code, roster, and Sharing.

This is consistent with **ADR-0001**: the content script owns all on-page rendering, there is no background service worker, and `content.js` is the sole navigation/DOM observer (it already emits `ytb:navigate` / `ytb:mutation`). The Room Home Section is one more consumer of those events plus the existing Room read.

We deliberately keep the section **short and horizontally laid out** (Feed left, Playlist right), small and scrollable, so it never pushes YouTube's grid far down the page. It renders only on the home route and must re-inject itself after SPA navigations back to home.

## Consequences

- A new content-script surface and a new consumer of the Room read live on the home page. It must gate strictly to the home route, tolerate YouTube's lazy-loaded grid, and re-inject after client-side navigation.
- The section depends on YouTube's home DOM structure, which is more fragile than the self-owned popup; a YouTube layout change can misplace it. The logic is isolated to one module so it can be repaired without touching Feed or Playlist data code.
- Unpaired users get a compact Create / Join prompt inside the section — a second entry point to Room setup beyond the popup. The popup remains the source of truth for identity and Room membership; both entry points must stay behaviorally consistent (reuse the same `YTB` / `YTBRoomCode` calls).
- The personalized Feed is derived entirely on the client from the existing Room read plus Playlist Events, so this surface adds **no** new read fan-out or per-recipient storage.
- If YouTube ever makes home-page injection untenable, the same Feed + Playlist components could fall back into the popup without changing the backend contracts.
