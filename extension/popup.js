// popup.js — identity, Room Code, and the pairing status dot (which doubles as
// the Sharing toggle: solid = sharing, hollow = not).
// Consumes the frozen `window.YTB` contract from shared.js (task 03). The popup is
// the only UI surface; all persisted state lives in chrome.storage.local (via YTB)
// so it survives a browser restart. See CONTEXT.md for terminology.

const ROSTER_POLL_MS = 5_000;

const el = {
	// Display Name (locked once set; Edit reopens the input).
	nameField: document.getElementById('name-field'),
	name: document.getElementById('name'),
	nameValue: document.getElementById('name-value'),
	nameEdit: document.getElementById('name-edit'),
	// Room Code views (mutually exclusive — only one is shown at a time).
	viewChooser: document.getElementById('view-chooser'),
	viewJoin: document.getElementById('view-join'),
	viewConnected: document.getElementById('view-connected'),
	chooseCreate: document.getElementById('choose-create'),
	chooseJoin: document.getElementById('choose-join'),
	chooserCancel: document.getElementById('chooser-cancel'),
	joinInput: document.getElementById('join-input'),
	joinSubmit: document.getElementById('join-submit'),
	joinFeedback: document.getElementById('join-feedback'),
	joinBack: document.getElementById('join-back'),
	code: document.getElementById('code'),
	copyCode: document.getElementById('copy-code'),
	copyFeedback: document.getElementById('copy-feedback'),
	leaveRoom: document.getElementById('leave-room'),
	status: document.getElementById('status'),
	statusText: document.getElementById('status-text'),
	statusSub: document.getElementById('status-sub'),
	roster: document.getElementById('roster'),
	colorGrid: document.getElementById('color-grid'),
	sharingDot: document.getElementById('sharing-dot'),
	backendUrl: document.getElementById('backend-url'),
	// Disconnect confirmation dialog.
	confirmOverlay: document.getElementById('confirm-overlay'),
	confirmTitle: document.getElementById('confirm-title'),
	confirmBody: document.getElementById('confirm-body'),
	confirmCancel: document.getElementById('confirm-cancel'),
	// The single confirm/OK button (id kept as confirm-disconnect); its label and
	// variant are set per-open by openConfirm.
	confirmOk: document.getElementById('confirm-disconnect'),
};

let myClientId = '';

// The action to run if the open confirm dialog is confirmed (set per-open;
// cleared on cancel/confirm). One dialog serves Leave room AND Stop sharing.
let pendingConfirm = null;

// Last-known Sharing state + whether the status dot is currently a live toggle
// (it is in waiting / in room; passive in Room full). Read by the dot's click.
let currentSharing = true;
let dotInteractive = false;

// Last-rendered roster, so a Buddy Color change can redraw without a re-GET.
let currentRosterBuddies = [];
let selectedBuddyId = '';
let activeRoomCode = '';

init();

async function init() {
	el.backendUrl.textContent = YTB.BACKEND_URL;

	// ensureClientId is generate-once; call on open so pairing comparisons are stable.
	myClientId = await YTB.ensureClientId();

	const config = await YTB.getConfig();
	el.name.value = config.name || '';
	el.nameValue.textContent = config.name || '';
	currentSharing = config.sharing;

	// The Display Name starts locked iff it already holds a non-empty committed
	// value, so a fresh install (blank name) opens in edit mode (onboarding unchanged).
	setFieldLocked(el.nameField, !!config.name);

	wireHandlers();
	setInterval(refreshConnectedRoom, ROSTER_POLL_MS);

	// Route to the right view: an active code → Connected (refresh status with a
	// real GET); otherwise the chooser (true first run, nothing to Cancel back to).
	if (config.code) {
		showConnected(config.code);
		// Re-assert presence on open: refreshes my TTL and backfills installs that
		// predate the presence feature.
		await YTB.assertPresence(config.code);
		await refreshStatus(config.code);
	} else {
		showView('chooser');
	}
}

function wireHandlers() {
	// Display Name is cosmetic; persist every keystroke so closing the popup never
	// loses input. Name collisions are harmless — identity is the Client ID.
	el.name.addEventListener('input', () => {
		YTB.setConfig({ name: el.name.value });
	});

	// Name commit: Enter or blur turns the editable name into a locked chip. There
	// is no Save button — unfocusing the field (or pressing Enter) just saves.
	el.name.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') commitName();
	});
	el.name.addEventListener('blur', commitName);

	// The pencil icon is unguarded (cosmetic) → reopen the input immediately.
	el.nameEdit.addEventListener('click', () => {
		setFieldLocked(el.nameField, false);
		el.name.focus();
	});

	// Chooser → Create: mint + commit a fresh code immediately (no confirm step).
	el.chooseCreate.addEventListener('click', () => createAndCommit());

	// Chooser → Join: switch to the free-text entry view.
	el.chooseJoin.addEventListener('click', () => {
		el.joinInput.value = '';
		updateJoinSubmit();
		showView('join');
		el.joinInput.focus();
	});

	// Chooser → Cancel: only reachable when a code already exists (via "Change
	// code"); return to Connected without touching the active code.
	el.chooserCancel.addEventListener('click', async () => {
		const { code } = await YTB.getConfig();
		if (!code) return; // No active code — nothing to cancel back to.
		showConnected(code);
		await refreshStatus(code);
	});

	// Join → submit: normalize (trim + lowercase) and commit verbatim. Pure match —
	// no word-list validation; pairing succeeds only if it matches a real code.
	el.joinSubmit.addEventListener('click', () => joinAndCommit());
	el.joinInput.addEventListener('input', () => {
		clearJoinError();
		updateJoinSubmit();
	});
	el.joinInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') joinAndCommit();
	});

	// Join → Back: abandon entry, return to the chooser (active code untouched).
	el.joinBack.addEventListener('click', () => showView('chooser'));

	// Connected → Copy: use the exact rendered label as the clipboard source of
	// truth and announce anchored success/failure feedback. The button is native
	// keyboard-accessible.
	el.copyCode.addEventListener('click', async () => {
		const text = el.code.textContent;
		if (!text) return;
		await YTBRoomCode.copy({
			text,
			feedback: el.copyFeedback,
		});
	});

	// Connected → Leave room: the explicit "leave this room" action. Always
	// confirm (copy adapts to whether a buddy is connected); on confirm, drop the
	// code and reopen the chooser.
	el.leaveRoom.addEventListener('click', () => {
		confirmDisconnectThen(clearCodeAndChoose);
	});

	// Confirm dialog: Cancel/backdrop/Escape dismiss; OK runs the pending action.
	// The dialog is never a trap.
	el.confirmCancel.addEventListener('click', hideConfirm);
	el.confirmOk.addEventListener('click', () => {
		const proceed = pendingConfirm;
		hideConfirm();
		if (proceed) proceed();
	});
	el.confirmOverlay.addEventListener('click', (e) => {
		if (e.target === el.confirmOverlay) hideConfirm();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !el.confirmOverlay.hidden) hideConfirm();
	});

	// The status dot is the Sharing toggle. Stopping (solid → off) is guarded by a
	// confirm; starting (off → solid) is instant. The reporter reads `sharing` and
	// stops/resumes its POSTs; the renderer keeps drawing the Buddy either way.
	el.sharingDot.addEventListener('click', () => {
		if (!dotInteractive) return; // passive in Room full (button is disabled too)
		if (currentSharing) {
			openConfirm({
				title: 'Stop sharing?',
				body: "Your Buddy won't see your progress until you start again.",
				confirmLabel: 'Stop sharing',
				variant: 'neutral',
				onConfirm: () => setSharing(false),
			});
		} else {
			setSharing(true);
		}
	});
}

// Keep the Join action unavailable and neutral until there is meaningful input.
function updateJoinSubmit() {
	const enabled = el.joinInput.value.trim().length > 0;
	el.joinSubmit.disabled = !enabled;
	el.joinSubmit.classList.toggle('primary', enabled);
}

// --- Display Name lock/edit ---------------------------------------------------

/** Toggle a field between locked (value chip + pencil) and editable (input). */
function setFieldLocked(field, locked) {
	field.classList.toggle('is-locked', locked);
}

// Commit the Display Name: trim, persist, mirror into the locked view, and lock
// only when non-empty (a blank name has nothing to lock, so it stays editable).
function commitName() {
	const name = el.name.value.trim();
	el.name.value = name;
	el.nameValue.textContent = name;
	setFieldLocked(el.nameField, name.length > 0);
	// Persist, then re-assert presence so the new name propagates to Buddies
	// immediately (best-effort, fire-and-forget).
	YTB.setConfig({ name }).then(() =>
		YTB.getConfig().then(({ code }) => {
			if (code) YTB.assertPresence(code);
		}),
	);
}

// --- Room Code flows (create / join) -----------------------------------------

// Create flow: generate a code, commit it, assert presence (so I appear to a
// Buddy who joins later even before I watch anything), then land on Connected.
// The GET shows me as the lone member → "No buddy joined yet :(" with a live dot.
async function createAndCommit() {
	const { code: oldCode } = await YTB.getConfig();
	const code = generateCode();
	await YTB.setConfig({ code });
	if (oldCode && oldCode !== code) {
		await YTB.deleteMember(oldCode, myClientId);
		await YTB.clearRoomColors(oldCode);
	}
	showConnected(code);
	await YTB.assertPresence(code);
	await refreshStatus(code);
}

// Join flow: verify that the typed Room already has a member, then commit it,
// assert my presence, and refresh status. The existence read must happen before
// any local config or old-Room membership changes.
async function joinAndCommit() {
	const code = YTB.normalizeCode(el.joinInput.value);
	if (!code) return; // Empty — stay on the entry view.
	const records = await YTB.getRecords(code);
	if (!YTB.roomExists(records)) {
		showJoinError("This room doesn't exist yet");
		return;
	}
	const { code: oldCode } = await YTB.getConfig();
	await YTB.setConfig({ code });
	if (oldCode && oldCode !== code) {
		await YTB.deleteMember(oldCode, myClientId);
		await YTB.clearRoomColors(oldCode);
	}
	showConnected(code);
	await YTB.assertPresence(code);
	await refreshStatus(code);
}

function showJoinError(message) {
	el.joinFeedback.textContent = message;
	el.joinFeedback.classList.add('is-error');
}

function clearJoinError() {
	el.joinFeedback.textContent = '';
	el.joinFeedback.classList.remove('is-error');
}

function generateCode() {
	return YTB.normalizeCode(YTBRoomCode.generate());
}

// --- confirmation dialog -----------------------------------------------------

// One reusable confirm dialog. Callers set the copy, the confirm button's label
// and variant ("danger" = red Disconnect; "neutral" = dark Stop sharing), and
// the action to run on confirm.
function openConfirm({ title, body, confirmLabel, variant, onConfirm }) {
	el.confirmTitle.textContent = title;
	el.confirmBody.textContent = body;
	el.confirmOk.textContent = confirmLabel;
	el.confirmOk.className = variant === 'danger' ? 'danger' : 'neutral';
	pendingConfirm = onConfirm;
	showConfirm();
}

// Confirm leaving the current room before `onProceed` (the red Leave variant).
// Copy adapts to whether a buddy is actually connected.
async function confirmDisconnectThen(onProceed) {
	const { code } = await YTB.getConfig();
	const names = await buddyNames(code);
	if (names.length > 0) {
		openConfirm({
			title: 'Are you sure you want to go?',
			body: `This will remove you from the room, away from: ${names.join(', ')}.`,
			confirmLabel: 'Leave',
			variant: 'danger',
			onConfirm: onProceed,
		});
	} else {
		openConfirm({
			title: 'Leave this room?',
			body: 'No buddy has joined the room yet.',
			confirmLabel: 'Leave',
			variant: 'danger',
			onConfirm: onProceed,
		});
	}
}

// Toggle Sharing and re-render the status dot. Off stops our POSTs (reporter
// reads the flag); the renderer keeps drawing the Buddy's markers either way.
async function setSharing(on) {
	currentSharing = on;
	await YTB.setConfig({ sharing: on });
	const { code } = await YTB.getConfig();
	await refreshStatus(code);
}

// Confirmed disconnect via Leave room. Remove membership server-side before
// clearing local state so the Room slot and Buddy markers are released.
async function clearCodeAndChoose() {
	const { code: oldCode } = await YTB.getConfig();
	await YTB.setConfig({ code: '' });
	if (oldCode) {
		await YTB.deleteMember(oldCode, myClientId);
		await YTB.clearRoomColors(oldCode);
	}
	el.code.textContent = '';
	showView('chooser');
}

// Buddy Display Names under `code` for the confirmation, via the shared roomView
// (same dedup-by-Client-ID the roster uses); an unnamed buddy falls back to a
// stable "<Adjective> Buddy" (YTB.buddyName), matching the roster and on-page
// tooltips. Room-full lockout is irrelevant here — I am already a member.
async function buddyNames(code) {
	if (!code) return [];
	const { buddies } = YTB.roomView(await YTB.getRecords(code), myClientId);
	return buddies.map((b) => YTB.buddyName(b.clientId, b.name));
}

function showConfirm() {
	el.confirmOverlay.hidden = false;
}

function hideConfirm() {
	el.confirmOverlay.hidden = true;
	pendingConfirm = null;
}

// --- view switching ----------------------------------------------------------

// Show exactly one of the three Room Code views. The Cancel link in the chooser
// only makes sense when an active code exists (reached via "Leave room").
function showView(name) {
	if (name === 'join') clearJoinError();
	el.viewChooser.hidden = name !== 'chooser';
	el.viewJoin.hidden = name !== 'join';
	el.viewConnected.hidden = name !== 'connected';
	if (name === 'chooser') {
		YTB.getConfig().then(({ code }) => {
			el.chooserCancel.hidden = !code;
		});
	}
}

// Render the Connected view for an active code, showing its pretty label. The
// copy button is always available (created or joined).
function showConnected(code) {
	el.code.textContent = YTBRoomCode.pretty(code);
	showView('connected');
}

// Room status, from my perspective (a Room Code is one Room of up to
// YTB.MAX_MEMBERS people):
//   Unpaired      — no code.
//   Waiting       — code set, but no Buddy has a record yet.
//   In room       — 1+ Buddies; list each with their color swatch + last-seen.
//   Room full     — 5 others already, I'm not one of them (the locked-out 6th).
async function refreshStatus(code) {
	if (!code) {
		setStatus('unpaired', 'Unpaired', 'Enter or generate a Room Code to join.');
		renderRoster([]);
		return;
	}

	const { sharing } = await YTB.getConfig();
	currentSharing = sharing;
	const records = await YTB.getRecords(code);
	const { buddies, locked } = YTB.roomView(records, myClientId);
	activeRoomCode = code;
	await YTB.syncBuddyColors(
		code,
		buddies.map((buddy) => buddy.clientId),
		records.ok,
	);

	if (locked) {
		// Room full: the dot is a passive dark indicator — no Sharing toggle here.
		setStatus('full', 'Room full', `This code already has ${YTB.MAX_MEMBERS} members.`, false);
		renderRoster([]);
		return;
	}

	if (buddies.length === 0) {
		setStatus('waiting', 'No buddy joined yet :(', '', true);
		renderRoster([]);
		return;
	}

	setStatus('inroom', 'Sharing', '', true);
	renderRoster(buddies);
}

async function refreshConnectedRoom() {
	const { code } = await YTB.getConfig();
	if (!code || el.viewConnected.hidden) return;
	await refreshStatus(code);
}

// Render the status line + its dot. `interactive` = the dot is the live Sharing
// toggle (waiting / in room); when false (Room full / unpaired) the dot is a
// passive indicator. Sharing off shows a hollow dot + a "· Not sharing" suffix.
function setStatus(state, text, sub, interactive = false) {
	const notSharing = interactive && !currentSharing;
	el.status.className = 'status is-' + state + (notSharing ? ' not-sharing' : '');
	el.statusText.textContent = notSharing ? text + ' · Not sharing' : text;
	el.statusSub.textContent = sub;

	dotInteractive = interactive;
	if (interactive) {
		const action = currentSharing ? 'Stop sharing' : 'Start sharing';
		el.sharingDot.disabled = false;
		el.sharingDot.setAttribute('aria-pressed', String(currentSharing));
		el.sharingDot.setAttribute('aria-label', action);
		el.sharingDot.title = action;
	} else {
		el.sharingDot.disabled = true;
		el.sharingDot.removeAttribute('aria-pressed');
		el.sharingDot.removeAttribute('title');
		el.sharingDot.setAttribute('aria-label', 'Sharing status');
	}
}

// Render one row per Buddy: [color swatch] name · last-seen. The swatch color
// matches that Buddy's markers/segments (YTB.buddyColor), so the popup doubles
// as the color legend. Newest-active Buddy first (roomView already sorts).
function renderRoster(buddies) {
	currentRosterBuddies = buddies;
	el.roster.textContent = '';
	for (const b of buddies) {
		const row = document.createElement('div');
		row.className = 'buddy';

		const swatch = document.createElement('button');
		swatch.className = 'swatch';
		swatch.style.background = YTB.buddyColor(b.clientId);
		swatch.type = 'button';
		swatch.setAttribute('aria-label', `Change color for ${YTB.buddyName(b.clientId, b.name)}`);
		swatch.addEventListener('click', () => openColorGrid(b.clientId));

		const name = document.createElement('span');
		name.className = 'buddy-name';
		name.textContent = YTB.buddyName(b.clientId, b.name);

		const seen = document.createElement('span');
		seen.className = 'buddy-seen';
		seen.textContent = formatLastSeen(b.updatedAt);

		row.append(swatch, name, seen);
		el.roster.appendChild(row);
	}
}

function openColorGrid(clientId) {
	selectedBuddyId = clientId;
	el.colorGrid.textContent = '';
	const room = YTB._buddyColors[activeRoomCode] || {};
	const used = new Set(
		Object.entries(room)
			.filter(([id]) => id !== clientId)
			.map(([, color]) => color),
	);
	for (const color of YTB.BUDDY_COLORS) {
		const button = document.createElement('button');
		button.className = 'color-choice';
		button.type = 'button';
		button.disabled = used.has(color);
		button.title = button.disabled ? 'Already assigned' : 'Choose color';
		button.setAttribute('aria-label', button.disabled ? `${color}, Already assigned` : `Choose ${color}`);
		button.setAttribute('aria-pressed', String(room[clientId] === color));
		const chip = document.createElement('span');
		chip.style.background = color;
		button.appendChild(chip);
		button.addEventListener('click', async () => {
			if (await YTB.setBuddyColor(activeRoomCode, selectedBuddyId, color)) {
				el.colorGrid.hidden = true;
				renderRoster(currentRosterBuddies);
			}
		});
		el.colorGrid.appendChild(button);
	}
	el.colorGrid.hidden = false;
	el.colorGrid.querySelector('[aria-pressed="true"]')?.focus();
}

// Wall-clock "last seen" for a record's updatedAt (ms epoch). YTB.formatTime is for
// video positions, not timestamps, so format relative time here.
function formatLastSeen(updatedAt) {
	const diff = Date.now() - updatedAt;
	const sec = Math.max(0, Math.round(diff / 1000));
	if (sec < 60) return 'just now';
	// Floor larger units so "X ago" never overstates how long it's been.
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}
