// extension/presence.js
//
// Presence asserter: announces "I'm here" under the active Room Code while the
// user is anywhere on YouTube — independent of watching and of the Sharing
// toggle. This is what makes a member appear to others the instant they have a
// code set, not only once they POST a Progress Record (the reporter's job).
//
// Loaded after shared.js (needs window.YTB) and before content.js, so its
// ytb:navigate listener is attached before content.js fires the initial event.
// A pure consumer of content.js's navigation events — it never detects
// navigation itself. Content scripts are NOT ES modules. See ADR-0001
// (docs/adr/0001-content-script-owned-sync.md).

(() => {
  "use strict";

  const ASSERT_INTERVAL_MS = 5 * 60_000; // throttle: at most once per ~5 min/tab

  let lastAssert = 0;

  // (Re)assert presence if the throttle window has elapsed. Best-effort and
  // independent of Sharing — presence means "I joined this Code", not "I'm
  // sharing my video position". Not gated to /watch: any page counts.
  async function maybeAssert() {
    if (Date.now() - lastAssert < ASSERT_INTERVAL_MS) return;
    const { code } = await YTB.getConfig();
    if (!code) return; // Unpaired — nobody to appear to.
    lastAssert = Date.now();
    YTB.assertPresence(code);
  }

  // Every navigation (not just /watch) is a chance to (re)assert; the throttle
  // keeps it to ~once per 5 min per tab regardless of how often the user nav's.
  document.addEventListener("ytb:navigate", maybeAssert);
})();
