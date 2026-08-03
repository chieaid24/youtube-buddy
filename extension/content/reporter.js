// extension/reporter.js
// POSTs this user's own Progress Records from /watch pages, skipping ads, live streams, Shorts, and embeds.
// Loaded 2nd (after shared.js, before content.js); talks only via window.YTB and content.js's ytb:navigate event (ADR-0001) - registered synchronously at top level so it catches content.js's initial ytb:navigate.

(() => {
	'use strict';

	const POST_INTERVAL_MS = 60_000; // post every ~60s while playing
	const MIN_TIMESTAMP_SECONDS = 5; // below this is noise - skip

	let intervalId = null;
	let boundVideo = null;
	let pauseHandler = null;
	let timeupdateHandler = null;

	// videoId we're reporting for, from the latest ytb:navigate - not re-read from the URL at post time, since SPA nav may already point at the next video.
	let currentVideoId = null;

	// Last valid { timestamp, duration } for currentVideoId, kept fresh via timeupdate, so SPA nav can flush the outgoing video's real final position.
	let lastPosition = null;

	// --- guards ------------------------------------------------------------

	// An embedded player is an iframe or a top-level /embed/ page - never report from either.
	function isEmbed() {
		return window.top !== window.self || location.pathname.startsWith('/embed/');
	}

	// During an ad the player carries `ad-showing` and `video.currentTime` is the ad's clock, not ours.
	function isAdShowing() {
		return !!document.querySelector('.html5-video-player.ad-showing');
	}

	function mainVideo() {
		return document.querySelector('video');
	}

	// The live { timestamp, duration } of the main player, or null when it can't/shouldn't be read (no element, or an ad).
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
		// postProgress reads the Room Code itself; a failed POST resolves falsy and is swallowed.
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
			if (pauseHandler) boundVideo.removeEventListener('pause', pauseHandler);
			if (timeupdateHandler) boundVideo.removeEventListener('timeupdate', timeupdateHandler);
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
		v.addEventListener('pause', pauseHandler);

		// Cheap: just keeps the latest valid position for navigate-away to flush; POST cadence is interval/pause/nav, not this snapshot.
		timeupdateHandler = () => {
			const pos = readPosition();
			if (pos && Number.isFinite(pos.duration)) lastPosition = pos;
		};
		v.addEventListener('timeupdate', timeupdateHandler);

		intervalId = setInterval(() => {
			if (boundVideo && !boundVideo.paused) postCurrent();
		}, POST_INTERVAL_MS);
	}

	// --- navigation (Contract C) -------------------------------------------

	document.addEventListener('ytb:navigate', (e) => {
		if (!YTB.isContextActive()) return;
		const nextVideoId = (e.detail && e.detail.videoId) || null;

		// Leaving the current video: flush its final position first, preferring the snapshot since the new video clobbers the shared <video> element.
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
