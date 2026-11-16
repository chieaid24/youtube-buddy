# Content-script-owned sync; no background service worker

The extension has no background service worker and no `chrome.alarms`. The content script owns the entire sync loop: it POSTs the user's Watch Record once per video, after about five seconds of real playback, and GETs the Room's records on load/navigation and every minute.

This deviates from the standard MV3 "background worker drives periodic work" pattern deliberately: playback only exists in the page (the `<video>` element's `timeupdate`), so a background alarm would have to wake up, find YouTube tabs, and message content scripts just to ask for data they already have. When no YouTube tab is open there is nothing to report and nobody to render for, so background syncing does zero useful work. The usual "don't use `setInterval` in MV3" rule applies to service workers, not content scripts — a content script lives as long as its tab.

## Consequences

- The manifest needs only `storage` plus host permissions — no `alarms`, no `background` entry.
- Buddy data is only as fresh as the last page load/navigation/poll tick; there is no syncing while YouTube is closed (by design — there'd be nothing to do).
- If push-style freshness is ever wanted, re-introduce a background worker for GET caching only; POSTing must stay in the content script regardless.
