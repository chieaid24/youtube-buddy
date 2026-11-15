// extension/content/reporter.js
// POSTs this member's Watch Record once a /watch video has really started playing, then nothing more for that video.
// Playback is counted locally and never sent; ads and live streams don't count (Shorts and embeds are not /watch).
// Loaded before content.js; talks only via window.YTB and the ytb:* events (ADR-0001).

(() => {
	'use strict';

	const STARTED_AFTER_SECONDS = 5; // playback before a video counts as watched
	const MAX_STEP_SECONDS = 2; // a bigger jump between samples is a seek, not playback
	const RETRY_MS = 60_000; // after an unsent mark (Unpaired, or a failed POST)

	let currentVideoId = null; // from the latest ytb:navigate; null off a watch page
	let played = 0; // seconds of currentVideoId played so far
	let lastTime = null; // previous currentTime sample; null restarts the chain
	let marked = false; // roomCode holds my Watch Record for currentVideoId
	let sending = false;
	let retryAt = 0;
	let roomCode = '';
	let myWatched = new Set(); // videoIds of my Watch Records in roomCode, as of the last successful read

	// During an ad the player carries `ad-showing` and the video runs on the ad's clock, not ours.
	function isAdShowing() {
		return !!document.querySelector('.html5-video-player.ad-showing');
	}

	async function mark(videoId) {
		if (sending || Date.now() < retryAt) return;
		if (myWatched.has(videoId)) {
			marked = true; // the Room already knows
			return;
		}
		sending = true;
		const sent = await YTB.postWatched(videoId);
		sending = false;
		if (sent) myWatched.add(videoId);
		if (videoId !== currentVideoId) return; // navigated away mid-flight
		if (sent) marked = true;
		else retryAt = Date.now() + RETRY_MS;
	}

	function onTimeUpdate(e) {
		if (marked || !currentVideoId || !YTB.isContextActive()) return;
		const video = e.target;
		if (video !== document.querySelector('video')) return; // only the main player
		if (isAdShowing() || !Number.isFinite(video.duration)) {
			lastTime = null; // ad, live stream, or not loaded
			return;
		}
		const step = lastTime === null ? 0 : video.currentTime - lastTime;
		lastTime = video.currentTime;
		if (step > 0 && step <= MAX_STEP_SECONDS) played += step;
		if (played >= STARTED_AFTER_SECONDS) mark(currentVideoId);
	}

	// timeupdate doesn't bubble; capturing at the document needs no binding to YouTube's player element.
	document.addEventListener('timeupdate', onTimeUpdate, true);

	document.addEventListener('ytb:navigate', (e) => {
		const nextVideoId = (e.detail && e.detail.videoId) || null;
		if (nextVideoId === currentVideoId) return; // same-video nudge, not a new viewing
		currentVideoId = nextVideoId;
		played = 0;
		lastTime = null;
		marked = false;
		retryAt = 0;
	});

	document.addEventListener('ytb:room-data', (e) => {
		const detail = e.detail || {};
		if (detail.roomCode !== roomCode) {
			// A different Room (or none) holds none of my marks yet.
			roomCode = detail.roomCode;
			myWatched = new Set();
			marked = false;
			retryAt = 0;
		}
		if (!detail.ok) return; // a failed read is not truth
		myWatched = new Set((detail.watched || []).filter((w) => w && w.clientId === detail.myClientId).map((w) => w.videoId));
	});

	YTB.onContextInvalidated(() => document.removeEventListener('timeupdate', onTimeUpdate, true));
})();
