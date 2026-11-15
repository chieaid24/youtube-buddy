// extension/content/room-poller.js
// The Room's single poller: GETs the Room on every ytb:navigate and every ~60s, and rebroadcasts each read as
// ytb:room-data for the other modules (none of them poll). Renders nothing.
// Loaded before content.js so its listener catches the first ytb:navigate (ADR-0001).

(function () {
	'use strict';

	const POLL_MS = 60_000; // ~1 GET/min/tab, so a Buddy's activity shows up without a navigation

	let myClientId = null;
	let activeRoomCode = '';
	let pollTimer = null;
	let readFailures = 0; // consecutive failed Room reads, folded via YTB.connectionState
	let connectionLost = false; // failures >= 2 - rides every ytb:room-data broadcast

	// GET the Room and broadcast it. Unpaired or locked out broadcasts empty;
	// a FAILED read still broadcasts (ok: false) so consumers keep their last state.
	async function refresh() {
		if (!YTB.isContextActive()) return;
		const { code } = await YTB.getConfig();
		if (!YTB.isContextActive()) return;
		if (!code) {
			activeRoomCode = '';
			readFailures = 0; // Unpaired: nothing is polled, so nothing can be "lost"
			connectionLost = false;
			broadcastRoomData(null, false);
			return;
		}
		myClientId = myClientId || (await YTB.ensureClientId());
		if (!YTB.isContextActive()) return;
		activeRoomCode = code;
		const records = await YTB.getRecords(code);
		const conn = YTB.connectionState(readFailures, records.ok);
		readFailures = conn.failures;
		connectionLost = conn.lost;
		if (!records.ok) {
			broadcastRoomData(records, false);
			return;
		}
		const view = YTB.roomView(records, myClientId);
		await YTB.syncBuddyColors(
			code,
			view.buddies.map((buddy) => buddy.clientId),
			records.ok,
		);
		if (!YTB.isContextActive()) return;
		broadcastRoomData(view.locked ? null : records, view.locked);
	}

	// `records` is null for an empty broadcast (no code, or locked out).
	function broadcastRoomData(records, locked) {
		const r = records || {};
		document.dispatchEvent(
			new CustomEvent('ytb:room-data', {
				detail: {
					notes: r.notes || [],
					replies: r.replies || [],
					watched: r.watched || [],
					presence: r.presence || [],
					playlist: r.playlist || [],
					events: r.events || [],
					roomCode: activeRoomCode,
					myClientId,
					locked: Boolean(locked),
					// False on a failed GET - never truth; notes.js prunes Unseen state only when ok (ADR-0010).
					ok: Boolean(r.ok),
					// >= 2 consecutive failed reads (YTB.connectionState); on every broadcast so consumers need no counter.
					connectionLost,
				},
			}),
		);
	}

	document.addEventListener('ytb:navigate', refresh);
	pollTimer = setInterval(refresh, POLL_MS);

	YTB.onContextInvalidated(() => {
		document.removeEventListener('ytb:navigate', refresh);
		if (pollTimer !== null) clearInterval(pollTimer);
		pollTimer = null;
	});
})();
