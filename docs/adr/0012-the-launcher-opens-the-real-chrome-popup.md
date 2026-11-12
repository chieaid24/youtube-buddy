# The Extension Popup launches Room Home

## Context

The Chrome toolbar popup previously held every identity, Room, Buddy Color, and Settings control. A separate launcher in YouTube's left guide opened that popup through a hidden extension-origin relay frame. The arrangement made a transient browser surface the main management UI and gave the guide row two unrelated actions.

ADR-0005 makes the Room Home Panel the complete in-page hub. The toolbar still needs to answer a viewer who clicks the extension icon out of curiosity, including when the current tab is not YouTube. Removing the popup would discard that entry point, while keeping its full controls would preserve two management surfaces.

## Decision

Keep the Chrome toolbar surface as the **Extension Popup**, with one destination action.

The Extension Popup shows the logo and **Youtube Buddy** heading above a button labelled **Check out your room!**. Room state, Room Code, Buddy count, Sharing, and Connection Lost belong in Room Home. Pressing the button immediately shows **Opening your room...** and marks it busy. Tab-creation failures show inline feedback and allow retry.

Your Room follows an exact tab rule:

- If the active tab is on the YouTube home route and responds within 500ms, open its Room Home Panel and close the popup. An already-open panel acknowledges the request without closing or resetting its view.
- Otherwise, create an active `https://www.youtube.com/#ytb-room` tab and dismiss the popup immediately. Focus moves before YouTube finishes loading.

An extension reload invalidates content scripts in existing tabs. A missing, stale, or unresponsive receiver therefore falls back to a fresh Home tab instead of a long retry loop and error. A watch page, another YouTube route, or another site is preserved.

The new tab's content script consumes the exact `#ytb-room` fragment during navigation initialization, removes it with `history.replaceState`, and opens Room Home. This tab-scoped launch intent survives popup dismissal and delayed page loading without a service worker or shared storage. Reloading that tab or opening another Home tab does not repeat the launch.

The Room Home Panel chooses its initial view after launch. Waiting and In room open the normal Feed and Recommendations view. Unpaired and Room full open Settings directly.

Remove the Control Panel term, the guide-row Control Panel Launcher, the hidden Relay Frame, and their failure toast. The Room Home Toggle remains the only control in the guide row. ADR-0001 still stands: the Extension Popup can launch or message a tab while it is open, so this flow does not justify a background service worker.

## Consequences

- The Extension Popup remains useful without duplicating any management mutation.
- Every edit lives in the Room Home Panel, where its effect is visible in the same YouTube context.
- Clicking Your Room from a watch page preserves the video by opening a new tab.
- New-tab launches must work after popup dismissal and before content scripts mount.
- The manifest no longer exposes the relay page as a web-accessible resource.
- Extension Popup tests cover the single button, dismissal, and launch routing. Live UI verification covers the Room Home Panel, including arrival from Your Room.
