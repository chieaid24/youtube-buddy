# The Extension Popup reports status and launches Room Home

## Context

The Chrome toolbar popup previously held every identity, Room, Buddy Color, and Settings control. A separate launcher in YouTube's left guide opened that popup through a hidden extension-origin relay frame. The arrangement made a transient browser surface the main management UI and gave the guide row two unrelated actions.

ADR-0005 makes the Room Home Panel the complete in-page hub. The toolbar still needs to answer a viewer who clicks the extension icon out of curiosity, including when the current tab is not YouTube. Removing the popup would discard that entry point, while keeping its full controls would preserve two management surfaces.

## Decision

Keep the Chrome toolbar surface as the **Extension Popup**, but reduce it to read-only status and one destination action.

The Extension Popup reports Room state, Room Code, Buddy count, Sharing state, and Connection Lost state. It changes none of them. Its only action is a button labelled **Your Room**.

Your Room follows an exact tab rule:

- If the active tab is already on the YouTube home route, reuse that tab and open its Room Home Panel.
- Otherwise, open a new YouTube Home tab and open the Room Home Panel after the home content script is ready.

A YouTube watch page, another YouTube route, another site, or no suitable active tab never gets navigated away. The launcher opens a new tab in each of those cases. The launch handoff must be one-shot so a later home tab cannot consume a stale request.

The Room Home Panel chooses its initial view after launch. Waiting and In room open the normal Feed and Recommendations view. Unpaired and Room full open Settings directly.

Remove the Control Panel term, the guide-row Control Panel Launcher, the hidden Relay Frame, and their failure toast. The Room Home Toggle remains the only control in the guide row. ADR-0001 still stands: the Extension Popup can launch or message a tab while it is open, so this flow does not justify a background service worker.

## Consequences

- The Extension Popup remains useful without duplicating any management mutation.
- Every edit lives in the Room Home Panel, where its effect is visible in the same YouTube context.
- Clicking Your Room from a watch page preserves the video by opening a new tab.
- The new-tab launch needs a tested ready handshake because the popup may close before the content script mounts.
- The manifest no longer exposes the relay page as a web-accessible resource.
- Extension Popup tests cover status and launch routing. Live UI verification covers the Room Home Panel, including arrival from Your Room.
