# The Control Panel Launcher opens the real Chrome action popup, via a relay frame

## Context

The Control Panel has two entry points to one document (`popup.html`): the toolbar icon, where
Chrome itself renders the action popup, and the Control Panel Launcher in the Room Home Toggle row.

The Launcher shipped as an **in-page facsimile**: an extension-origin iframe of `popup.html`
centered over a dim scrim, with its own close chip, focus trap, and a `postMessage` height protocol
(the host cannot read the frame's height across the origin boundary, so `popup.js` posts it). It is
the same document, but it is not the same _thing_: it sits in the page rather than in the browser,
it is modal where the popup is transient, and its chrome is ours to maintain forever. Two
presentations of one surface is one too many, and the second one drifts.

The goal is for the Launcher to open the Control Panel **exactly** as the toolbar icon does -- not a
lookalike, the real popup.

Chrome exposes `chrome.action.openPopup()` (generally available in Chrome 127+; before that,
policy-installed extensions only). It is not available to content scripts: `chrome.action` exists
only in extension contexts. ADR-0001 put the whole sync loop in the content script and deliberately
ships **no background service worker**, so there is no extension context to call it from.

Three shapes were on the table:

- **(a) Add a background service worker** purely to relay one message to one API call. It reaches
  the API, and it reverses ADR-0001's central claim for a feature that has nothing to do with sync.
  A service worker is not free: it has a lifecycle, it wakes, it is another place state can live and
  another thing to reason about at load.
- **(b) Relay through an extension-origin frame.** The Launcher already proved that an extension
  page embedded in a YouTube tab gets the `chrome.*` APIs (that is how the overlay iframe reads
  `chrome.storage`). A hidden, zero-size extension page can therefore call `chrome.action.openPopup()`
  on behalf of the content script, which reaches it by `postMessage`.
- **(c) Keep the facsimile** and restyle it to look like a Chrome popup: anchored top-right, no
  scrim, Chrome's radius and shadow. Always in one place, instant, screenshottable -- and a
  permanent lookalike that must be re-matched every time Chrome's popup chrome changes.

**(b) was verified before being chosen**, not assumed. In real Chromium, driving the exact
production shape -- a trusted click in the YouTube page, `postMessage` into an embedded
extension-origin iframe, the frame calling `chrome.action.openPopup()` -- the call resolves and
`chrome.runtime.getContexts({ contextTypes: ['POPUP'] })` goes from 0 to 1: Chrome instantiated the
genuine action popup. Two properties matter and both held: `chrome.action` **is** defined in an
extension frame embedded in a web page, and `openPopup()` needs **no user gesture in the calling
frame** -- which is the crux, because a gesture does not cross the frame boundary, so a design that
required one could not be driven from a click in the host page. The extension was unpinned in the
test profile, and the popup still opened.

## Decision

**(b).** The Launcher opens the real Chrome action popup. A hidden extension-origin relay frame is
the content script's only reach into `chrome.action`; no background service worker is added, and
ADR-0001 stands.

The in-page overlay is **deleted, not kept as a fallback**: the card, the scrim, the focus trap, and
the `popup.js` height protocol all go. There is exactly one Control Panel presentation again, and it
is the browser's.

`openPopup()` can still throw -- `Could not find an active browser window`, or a Chrome older than 127. A throw is **not** a silent dead end and **not** a reason to resurrect the overlay: the click
surfaces a toast pointing the viewer at the toolbar icon, which is the same document one click away.
This is why `showToast` is promoted out of `renderer.js` into a shared helper -- one toast
implementation, two callers.

## Consequences

The Control Panel is the Control Panel. There is no second presentation to style, to focus-trap, to
size, or to keep in sync -- a change to `popup.html` lands identically in both entry points because
there is only one rendering of it.

**Chrome owns the placement, and we accept it.** The popup opens anchored to the toolbar at the
top-right of the browser window -- far from the Launcher click at the bottom-left of the guide -- and
if the viewer has not pinned YouTube Buddy, it anchors under the puzzle-piece menu instead. This is
the deliberate price of the popup being real: its position is the browser's to decide, and no API
moves it. Shipping real extension icons is what makes the anchor legible, so the popup visibly
belongs to the YouTube Buddy icon rather than appearing from nowhere.

**The native popup is invisible to Playwright.** It is browser chrome, not web content: it is not a
`page`, and it cannot be screenshotted. The repo's live-UI gate cannot eyeball this surface the way
it eyeballs an in-page one. The deterministic replacement is the assertion the spike already relies
on -- after a Launcher click, `getContexts({ contextTypes: ['POPUP'] })` reports a popup context --
which is a stronger check than a screenshot anyway: it proves Chrome opened the real popup, which no
facsimile could ever pass.

The hidden relay frame is the surprising artifact, and the reason this is written down: a zero-size
extension iframe on the home route whose entire job is to forward one message to one API call. It
looks like something to clean up. It is load-bearing, and removing it means either a service worker
or going back to (c).
