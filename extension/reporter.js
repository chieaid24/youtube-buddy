// extension/reporter.js
//
// Reporter (task 05): POSTs THIS user's own Progress Records from /watch pages,
// with all the skip-guards so ads, live streams, Shorts, and embeds never
// produce a record. PRD plan-of-record step 5.
//
// Loaded as the 2nd content-script file (after shared.js, before content.js).
// Content scripts are NOT ES modules — this file communicates only via the
// `window.YTB` global (from shared.js) and the `ytb:navigate` event dispatched
// by content.js. No imports. See docs/adr/0001-content-script-owned-sync.md.
//
// content.js owns the single navigation observer; we never detect navigation
// ourselves. The listener below is registered synchronously at top level so it
// is attached before content.js (which loads last) fires the initial
// ytb:navigate.

(() => {
  "use strict";

  const POST_INTERVAL_MS = 60_000; // post every ~60s while playing
  const MIN_TIMESTAMP_SECONDS = 5; // below this is noise — skip

  let intervalId = null;
  let boundVideo = null;
  let pauseHandler = null;
  let timeupdateHandler = null;

  // The videoId we are currently reporting for — taken from the latest
  // ytb:navigate (NOT re-read from the URL at post time, because on SPA nav the
  // URL/<video> may already point at the NEXT video by the time we POST).
  let currentVideoId = null;

  // Last valid { timestamp, duration } observed for currentVideoId, kept fresh
  // via `timeupdate`. Used to report the OUTGOING video's final position on SPA
  // navigation, since a fresh read at nav time can already be the next video.
  let lastPosition = null;

  // --- guards ------------------------------------------------------------

  // An embedded player runs in an iframe, or is a top-level /embed/ page. Either
  // way the content script must not report from it.
  function isEmbed() {
    return (
      window.top !== window.self || location.pathname.startsWith("/embed/")
    );
  }

  // During an ad the player carries `ad-showing`, and `video.currentTime` is the
  // AD's clock — reading it would corrupt the record.
  function isAdShowing() {
    return !!document.querySelector(".html5-video-player.ad-showing");
  }

  function mainVideo() {
    return document.querySelector("video");
  }

  // The live { timestamp, duration } of the main player, or null when it can't
  // / shouldn't be read right now (no element, or an ad is showing).
  function readPosition() {
    if (isAdShowing()) return null;
    const v = mainVideo();
    if (!v) return null;
    return { timestamp: v.currentTime, duration: v.duration };
  }

  // --- posting -----------------------------------------------------------

  async function post(videoId, position) {
    if (!videoId || !position) return;
    if (!Number.isFinite(position.duration)) return; // live stream / not loaded
    if (position.timestamp < MIN_TIMESTAMP_SECONDS) return; // noise
    if (isEmbed()) return;

    const config = await YTB.getConfig();
    if (!config.sharing || !config.code) return; // Sharing off, or unpaired.

    const clientId = await YTB.ensureClientId();
    // postProgress reads the Room Code from config itself; we pass only the
    // 5 record fields. A failed POST resolves falsy and is swallowed.
    await YTB.postProgress({
      clientId,
      name: config.name,
      videoId,
      timestamp: position.timestamp,
      duration: position.duration,
    });
  }

  // Post the live position of the current video (interval tick + pause).
  function postCurrent() {
    post(currentVideoId, readPosition());
  }

  // --- binding to the active <video> -------------------------------------

  function unbind() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (boundVideo) {
      if (pauseHandler) boundVideo.removeEventListener("pause", pauseHandler);
      if (timeupdateHandler)
        boundVideo.removeEventListener("timeupdate", timeupdateHandler);
    }
    boundVideo = null;
    pauseHandler = null;
    timeupdateHandler = null;
  }

  function bind() {
    if (!YTB.isContextActive()) return;
    unbind();
    const v = mainVideo();
    if (!v) return;
    boundVideo = v;

    pauseHandler = () => postCurrent();
    v.addEventListener("pause", pauseHandler);

    // Cheap: just keep the latest valid position so navigate-away can flush the
    // OUTGOING video's real final time. The POST cadence is the interval / pause
    // / nav events — not this snapshot.
    timeupdateHandler = () => {
      const pos = readPosition();
      if (pos && Number.isFinite(pos.duration)) lastPosition = pos;
    };
    v.addEventListener("timeupdate", timeupdateHandler);

    intervalId = setInterval(() => {
      if (boundVideo && !boundVideo.paused) postCurrent();
    }, POST_INTERVAL_MS);
  }

  // --- navigation (Contract C) -------------------------------------------

  document.addEventListener("ytb:navigate", (e) => {
    if (!YTB.isContextActive()) return;
    const nextVideoId = (e.detail && e.detail.videoId) || null;

    // Leaving the current video (to another video, or off /watch entirely):
    // flush its final position before we lose it. Prefer the snapshot, which
    // predates the new video clobbering the shared <video> element.
    if (currentVideoId && currentVideoId !== nextVideoId) {
      post(currentVideoId, lastPosition || readPosition());
    }

    currentVideoId = nextVideoId;
    lastPosition = null;

    if (currentVideoId) bind();
    else unbind();
  });

  YTB.onContextInvalidated(unbind);
})();
