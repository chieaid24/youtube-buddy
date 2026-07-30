// popup.js -- identity, Room Code, and Sharing controls. Consumes shared.js's YTB
// contract; state persists in chrome.storage.local. See CONTEXT.md / DESIGN.md.

const ROSTER_POLL_MS = 5_000;

const el = {
	// Display Name (locked once set; the pencil reopens the input).
	nameField: document.getElementById('name-field'),
	name: document.getElementById('name'),
	nameValue: document.getElementById('name-value'),
	nameEdit: document.getElementById('name-edit'),
	// Room Code views (mutually exclusive -- only one is shown at a time).
	viewChooser: document.getElementById('view-chooser'),
	viewJoin: document.getElementById('view-join'),
	viewConnected: document.getElementById('view-connected'),
	chooseCreate: document.getElementById('choose-create'),
	createFeedback: document.getElementById('create-feedback'),
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
	sharingOn: document.getElementById('sharing-on'),
	sharingTurnOn: document.getElementById('sharing-turn-on'),
	backendUrl: document.getElementById('backend-url'),
	// Settings view (the fourth mutually-exclusive view; gear in the header).
	roomSection: document.getElementById('room-section'),
	viewSettings: document.getElementById('view-settings'),
	settingsOpen: document.getElementById('settings-open'),
	settingsBack: document.getElementById('settings-back'),
	themeSeg: document.getElementById('theme-seg'),
	edgePicker: document.getElementById('edge-picker'),
	setNotes: document.getElementById('set-notes'),
	setProgress: document.getElementById('set-progress'),
	setSpoiler: document.getElementById('set-spoiler'),
	setHome: document.getElementById('set-home'),
	settingsRoom: document.getElementById('settings-room'),
	settingsSharing: document.getElementById('settings-sharing'),
	// Disconnect confirmation dialog.
	confirmOverlay: document.getElementById('confirm-overlay'),
	confirmTitle: document.getElementById('confirm-title'),
	confirmBody: document.getElementById('confirm-body'),
	confirmCancel: document.getElementById('confirm-cancel'),
	// Single confirm/OK button (id kept as confirm-disconnect); label/variant set per-open.
	confirmOk: document.getElementById('confirm-disconnect'),
};

let myClientId = '';

// Action to run when the open confirm dialog is confirmed; one dialog serves
// Leave room AND Stop sharing.
let pendingConfirm = null;

// Last-known Sharing state.
let currentSharing = true;

// Settings snapshot driving the Settings controls (5 YTB.getSettings keys plus
// homeSectionHidden); null until init has read storage.
let currentSettings = null;

// The room view to land on when Settings closes (Back or the gear again).
let settingsReturn = 'chooser';

// Last-rendered roster, so a Buddy Color change can redraw without a re-GET.
let currentRosterBuddies = [];
// Full Room roster (incl. me) from the last read, for Room-unique Buddy labels.
let currentRoster = [];
let selectedBuddyId = '';
let activeRoomCode = '';

// Consecutive Room-read failures for this popup's poller; resets via the shared
// Connection Lost rule on a successful read.
let connectionFailures = 0;

// Roster ids from the previous render, so a genuinely new Buddy row animates in
// while unchanged rows stay still on the 5s poll. null = no render yet.
let prevRosterIds = null;

// Buddy whose swatch should do the one-shot pick wiggle on the next render.
let lastPickedBuddyId = '';

init();

async function init() {
	el.backendUrl.textContent = YTB.BACKEND_URL;

	// ensureClientId is generate-once; call on open so pairing comparisons are stable.
	myClientId = await YTB.ensureClientId();

	const config = await YTB.getConfig();
	el.name.value = config.name || '';
	el.nameValue.textContent = config.name || '';
	currentSharing = config.sharing;

	// Locked iff a name is already committed; a fresh install (blank name) opens in edit mode.
	setFieldLocked(el.nameField, !!config.name);

	// Read stored preferences once and reflect them into the controls (theme.js
	// already stamped data-theme).
	currentSettings = {
		...(await YTB.getSettings()),
		homeSectionHidden: await YTB.getHomeSectionHidden(),
	};
	buildEdgePicker();
	renderSettingsControls();

	wireHandlers();
	setInterval(refreshConnectedRoom, ROSTER_POLL_MS);

	// An active code -> Connected (refresh via a real GET); otherwise the chooser.
	if (config.code) {
		showConnected(config.code);
		// Re-assert presence to refresh TTL; not awaited so a slow/dead backend
		// can't block Leave room and the rest of the room-derived controls.
		YTB.assertPresence(config.code);
		await refreshStatus(config.code);
	} else {
		showView('chooser');
	}
}

function wireHandlers() {
	// Persist every keystroke so closing the popup never loses input; name
	// collisions are harmless since identity is the Client ID.
	el.name.addEventListener('input', () => {
		YTB.setConfig({ name: el.name.value });
	});

	// Enter or blur commits the name into a locked chip; there is no Save button.
	el.name.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') commitName();
	});
	el.name.addEventListener('blur', commitName);

	// The pencil icon is unguarded (cosmetic) -> reopen the input immediately.
	el.nameEdit.addEventListener('click', () => {
		setFieldLocked(el.nameField, false);
		el.name.focus();
	});

	el.chooseCreate.addEventListener('click', () => createAndCommit());

	el.chooseJoin.addEventListener('click', () => {
		el.joinInput.value = '';
		updateJoinSubmit();
		showView('join');
		el.joinInput.focus();
	});

	// Only reachable when a code already exists; returns to Connected untouched.
	el.chooserCancel.addEventListener('click', async () => {
		const { code } = await YTB.getConfig();
		if (!code) return; // No active code -- nothing to cancel back to.
		showConnected(code);
		await refreshStatus(code);
	});

	// Pure match, no word-list validation; pairing succeeds only against a real code.
	el.joinSubmit.addEventListener('click', () => joinAndCommit());
	el.joinInput.addEventListener('input', () => {
		clearJoinError();
		updateJoinSubmit();
	});
	el.joinInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') joinAndCommit();
	});

	// Join -> Back: abandon entry, return to the chooser (active code untouched).
	el.joinBack.addEventListener('click', () => showView('chooser'));

	// Use the exact rendered label as the clipboard source of truth.
	el.copyCode.addEventListener('click', async () => {
		const text = el.code.textContent;
		if (!text) return;
		await YTBRoomCode.copy({
			text,
			feedback: el.copyFeedback,
			button: el.copyCode,
		});
	});

	// Always confirm (copy adapts to whether a buddy is connected).
	el.leaveRoom.addEventListener('click', () => {
		confirmDisconnectThen(clearCodeAndChoose);
	});

	// Cancel/backdrop/Escape dismiss; OK runs the pending action.
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
		if (e.key !== 'Escape') return;
		if (!el.confirmOverlay.hidden) hideConfirm();
		else if (!el.colorGrid.hidden) closeColorGrid();
	});

	// Same click-anywhere-else dismissal as the confirm dialog; swatch clicks stop
	// propagation (see renderRoster) so only closing clicks reach here.
	document.addEventListener('click', (e) => {
		if (el.colorGrid.hidden || el.colorGrid.contains(e.target)) return;
		closeColorGrid();
	});

	// Turn-ON is instant and unguarded (the guarded stop lives in Settings);
	// reporter.js reads `sharing` to stop/resume POSTs, renderer.js draws regardless.
	el.sharingTurnOn.addEventListener('click', () => setSharing(true));

	// Gear toggles Settings open/closed; Back returns to the room view it opened from.
	el.settingsOpen.addEventListener('click', () => {
		if (el.viewSettings.hidden) openSettings();
		else closeSettings();
	});
	el.settingsBack.addEventListener('click', () => closeSettings());

	// Stamp data-theme immediately; theme.js's onChanged listener does the same
	// in every open YouTube tab.
	for (const button of el.themeSeg.querySelectorAll('[data-theme-choice]')) {
		button.addEventListener('click', () => saveSettings({ theme: button.dataset.themeChoice }));
	}

	// Visibility + Spoiler Default toggle rows (each stores its documented key).
	el.setNotes.addEventListener('click', () => saveSettings({ notesHidden: !currentSettings.notesHidden }));
	el.setProgress.addEventListener('click', () => saveSettings({ buddyProgressHidden: !currentSettings.buddyProgressHidden }));
	el.setSpoiler.addEventListener('click', () => saveSettings({ spoilerDefault: !currentSettings.spoilerDefault }));
	el.setHome.addEventListener('click', () => saveSettings({ homeSectionHidden: !currentSettings.homeSectionHidden }));

	// Sharing stops with confirmation and starts immediately.
	el.settingsSharing.addEventListener('click', () => {
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

	// Keep Settings controls honest when a preference changes elsewhere while
	// open (e.g. the Room Home Toggle in YouTube's guide).
	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area !== 'local' || !currentSettings) return;
		const keys = ['theme', 'spoilerDefault', 'notificationPosition', 'notesHidden', 'buddyProgressHidden', 'homeSectionHidden'];
		if (!keys.some((key) => key in changes)) return;
		currentSettings = {
			...(await YTB.getSettings()),
			homeSectionHidden: await YTB.getHomeSectionHidden(),
		};
		renderSettingsControls();
	});
}

// Join action stays disabled/neutral until there is input, then promotes to primary.
function updateJoinSubmit() {
	const enabled = el.joinInput.value.trim().length > 0;
	el.joinSubmit.disabled = !enabled;
	el.joinSubmit.classList.toggle('btn-primary', enabled);
}

// --- Display Name lock/edit ---------------------------------------------------

/** Toggle the field between locked (value chip + pencil) and editable (input). */
function setFieldLocked(field, locked) {
	field.classList.toggle('is-locked', locked);
}

// Trim, persist, mirror into the locked view; locks only when non-empty.
function commitName() {
	const name = el.name.value.trim();
	el.name.value = name;
	el.nameValue.textContent = name;
	setFieldLocked(el.nameField, name.length > 0);
	// Persist, then re-assert presence so the new name propagates to Buddies (best-effort).
	YTB.setConfig({ name }).then(() =>
		YTB.getConfig().then(({ code }) => {
			if (code) YTB.assertPresence(code);
		}),
	);
}

// --- Room Code flows (create / join) -----------------------------------------

// Generate a code, commit it, assert presence (so I appear even before watching
// anything), then land on Connected.
async function createAndCommit() {
	clearCreateError();
	const { code: oldCode } = await YTB.getConfig();
	let code;
	try {
		code = await YTBRoomCode.generateAvailable({
			checkTaken: async (candidate) => {
				const records = await YTB.getRecords(candidate);
				if (!records.ok) return 'failed';
				return records.progress.length > 0 || records.presence.length > 0 ? 'taken' : 'free';
			},
		});
	} catch (error) {
		if (error instanceof YTBRoomCode.CheckFailedError) {
			showCreateError("Couldn't reach the server -- try again.");
			return;
		}
		throw error;
	}
	code = YTB.normalizeCode(code);
	await YTB.setConfig({ code });
	if (oldCode && oldCode !== code) {
		await YTB.deleteMember(oldCode, myClientId);
		await YTB.clearRoomColors(oldCode);
	}
	showConnected(code);
	await YTB.assertPresence(code);
	await refreshStatus(code);
}

function showCreateError(message) {
	el.createFeedback.textContent = message;
	el.createFeedback.classList.add('is-error');
}

function clearCreateError() {
	el.createFeedback.textContent = '';
	el.createFeedback.classList.remove('is-error');
}

// Verify the typed Room has a member before committing any local config or
// old-Room membership changes; then assert presence and refresh status.
async function joinAndCommit() {
	const code = YTB.normalizeCode(el.joinInput.value);
	if (!code) return; // Empty -- stay on the entry view.
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

// --- confirmation dialog -----------------------------------------------------

// One reusable confirm dialog; callers set copy, button label/variant ("danger" =
// red Leave, "neutral" = warm charcoal Stop sharing), and the confirm action.
function openConfirm({ title, body, confirmLabel, variant, onConfirm }) {
	el.confirmTitle.textContent = title;
	el.confirmBody.textContent = body;
	el.confirmOk.textContent = confirmLabel;
	el.confirmOk.className = 'btn ' + (variant === 'danger' ? 'btn-danger' : 'btn-neutral');
	pendingConfirm = onConfirm;
	showConfirm();
}

// Opens on local state alone (never gated on a Room read, so leaving still works
// while the backend is unreachable); the buddy-names copy is an enrichment that
// fills in once the read lands, or stays generic if it never does.
async function confirmDisconnectThen(onProceed) {
	openConfirm({
		title: 'Leave this room?',
		body: 'This will remove you from the room.',
		confirmLabel: 'Leave',
		variant: 'danger',
		onConfirm: onProceed,
	});
	const { code } = await YTB.getConfig();
	const names = await buddyNames(code);
	// A slow read must not overwrite a dialog already dismissed/reopened elsewhere.
	if (pendingConfirm !== onProceed) return;
	if (names.length > 0) {
		el.confirmTitle.textContent = 'Are you sure you want to go?';
		el.confirmBody.textContent = `This will remove you from the room, away from: ${names.join(', ')}.`;
	} else {
		el.confirmBody.textContent = 'No buddy has joined the room yet.';
	}
}

// Off stops our POSTs (reporter reads the flag); renderer keeps drawing regardless.
async function setSharing(on) {
	currentSharing = on;
	await YTB.setConfig({ sharing: on });
	const { code } = await YTB.getConfig();
	await refreshStatus(code);
}

// Leaving is local state: clear it and land on the chooser at once, then release
// membership server-side (not a gate -- an unreachable backend must not trap the
// viewer, and TTL cleans up the records anyway if the DELETE never lands).
async function clearCodeAndChoose() {
	const { code: oldCode } = await YTB.getConfig();
	await YTB.setConfig({ code: '' });
	el.code.textContent = '';
	activeRoomCode = '';
	updateSettingsRoomControls();
	showView('chooser');
	if (oldCode) {
		await YTB.clearRoomColors(oldCode);
		await YTB.deleteMember(oldCode, myClientId);
	}
}

// Buddy Display Names for the confirmation, via the shared roomView (same
// dedup-by-Client-ID the roster uses); unnamed buddies fall back to YTB.buddyName.
async function buddyNames(code) {
	if (!code) return [];
	const records = await YTB.getRecords(code);
	const roster = YTB.roomRoster(records);
	const { buddies } = YTB.roomView(records, myClientId);
	return buddies.map((b) => YTB.buddyName(b.clientId, b.name, roster));
}

function showConfirm() {
	el.confirmOverlay.hidden = false;
	// Land keyboard users on the safe action; Escape/backdrop still dismiss.
	el.confirmCancel.focus();
}

function hideConfirm() {
	el.confirmOverlay.hidden = true;
	pendingConfirm = null;
}

// --- Settings ------------------------------------------------------------------

// Remember which room view was showing, then present Settings.
function openSettings() {
	settingsReturn = !el.viewConnected.hidden ? 'connected' : !el.viewJoin.hidden ? 'join' : 'chooser';
	showView('settings');
}

// Return to the room view Settings opened from; Connected re-routes through a
// real GET since state may have changed while in Settings.
async function closeSettings() {
	const { code } = await YTB.getConfig();
	if (settingsReturn === 'connected' && code) {
		showConnected(code);
		await refreshStatus(code);
	} else if (settingsReturn === 'join' || !code) {
		showView(settingsReturn === 'join' ? 'join' : 'chooser');
	} else {
		showView('chooser');
	}
}

// Merge into currentSettings and re-render. homeSectionHidden has its own storage
// seam; everything else goes through YTB.setSettings. A theme change also stamps
// data-theme here immediately, mirroring theme.js's cross-tab onChanged listener.
function saveSettings(partial) {
	if (!currentSettings) return;
	currentSettings = { ...currentSettings, ...partial };
	renderSettingsControls();
	if ('theme' in partial) {
		if (partial.theme === 'light' || partial.theme === 'dark') document.documentElement.setAttribute('data-theme', partial.theme);
		else document.documentElement.removeAttribute('data-theme');
	}
	const { homeSectionHidden, ...rest } = partial;
	if (homeSectionHidden !== undefined) YTB.setHomeSectionHidden(homeSectionHidden);
	if (Object.keys(rest).length > 0) YTB.setSettings(rest);
}

// Reading order so tab order matches the plus layout the CSS paints.
const EDGE_PICKER_ORDER = ['top', 'left', 'right', 'bottom'];

function buildEdgePicker() {
	el.edgePicker.textContent = '';
	for (const edge of EDGE_PICKER_ORDER) {
		const cell = document.createElement('button');
		cell.type = 'button';
		cell.className = 'edge-cell';
		cell.dataset.edge = edge;
		cell.setAttribute('role', 'radio');
		cell.setAttribute('aria-checked', 'false');
		cell.title = edge;
		cell.setAttribute('aria-label', 'Notifications at ' + edge);
		cell.addEventListener('click', () => saveSettings({ notificationPosition: edge }));
		el.edgePicker.appendChild(cell);
	}
}

/** Reflect a switch row's on/off state (checked means the feature is ON). */
function setSwitch(row, on) {
	row.setAttribute('aria-checked', String(on));
}

// Reflect currentSettings into every control; visibility rows read as "shown"
// switches, so their checked state is the inverse of the stored *Hidden keys.
function renderSettingsControls() {
	if (!currentSettings) return;
	for (const button of el.themeSeg.querySelectorAll('[data-theme-choice]')) {
		button.setAttribute('aria-checked', String(button.dataset.themeChoice === currentSettings.theme));
	}
	for (const cell of el.edgePicker.querySelectorAll('.edge-cell')) {
		cell.setAttribute('aria-checked', String(cell.dataset.edge === currentSettings.notificationPosition));
	}
	setSwitch(el.setNotes, !currentSettings.notesHidden);
	setSwitch(el.setProgress, !currentSettings.buddyProgressHidden);
	setSwitch(el.setSpoiler, currentSettings.spoilerDefault);
	setSwitch(el.setHome, !currentSettings.homeSectionHidden);
	updateSettingsRoomControls();
}

// The Room group holds only Leave room and is hidden while Unpaired.
function updateSettingsRoomControls() {
	el.settingsRoom.hidden = !activeRoomCode;
	setSwitch(el.settingsSharing, currentSharing);
}

// --- view switching ----------------------------------------------------------

// Show exactly one of the four views; re-unhiding restarts its CSS enter animation.
// The chooser's Cancel link only makes sense when an active code exists.
function showView(name) {
	if (name === 'join') clearJoinError();
	if (name !== 'chooser') clearCreateError();
	el.roomSection.hidden = name === 'settings';
	el.viewSettings.hidden = name !== 'settings';
	el.viewChooser.hidden = name !== 'chooser';
	el.viewJoin.hidden = name !== 'join';
	el.viewConnected.hidden = name !== 'connected';
	if (name === 'chooser') {
		YTB.getConfig().then(({ code }) => {
			el.chooserCancel.hidden = !code;
		});
	}
}

// Render the Connected view for an active code, showing its pretty label.
function showConnected(code) {
	el.code.textContent = YTBRoomCode.pretty(code);
	showView('connected');
}

// Room status from my perspective: Unpaired (no code), Waiting (code set, no
// Buddy record yet), In room (1+ Buddies, listed with swatch + last-seen), or
// Room full (5 others already, I'm the locked-out 6th).
async function refreshStatus(code) {
	if (!code) {
		activeRoomCode = '';
		setStatus('unpaired', 'Unpaired', 'Enter or generate a Room Code to join.');
		renderRoster([]);
		return;
	}

	const { sharing } = await YTB.getConfig();
	currentSharing = sharing;
	// Keep Leave room available while backend reads are pending.
	activeRoomCode = code;
	updateSettingsRoomControls();

	const records = await YTB.getRecords(code);
	const connection = YTB.connectionState(connectionFailures, records.ok);
	connectionFailures = connection.failures;

	if (!records.ok) {
		setStatus(
			connection.lost ? 'connection-lost' : 'connecting',
			connection.lost ? "Can't reach the backend" : 'Connecting to Room',
			connection.lost ? 'Retrying...' : '',
			true,
		);
		// Keep the last-known roster and its colors on screen during an outage.
		return;
	}

	const { buddies, locked } = YTB.roomView(records, myClientId);
	currentRoster = YTB.roomRoster(records);
	await YTB.syncBuddyColors(
		code,
		buddies.map((buddy) => buddy.clientId),
		records.ok,
	);

	if (locked) {
		setStatus('full', 'Room full', `This code already has ${YTB.MAX_MEMBERS} members.`, false);
		renderRoster([]);
		return;
	}

	if (buddies.length === 0) {
		setStatus('waiting', 'Waiting for buddies', '', true);
		renderRoster([]);
		return;
	}

	setStatus('inroom', 'Buddies', '', true);
	renderRoster(buddies, currentRoster);
}

async function refreshConnectedRoom() {
	const { code } = await YTB.getConfig();
	if (!code || el.viewConnected.hidden) return;
	await refreshStatus(code);
}

// Waiting/in-room states show Sharing state (read-only "on" line, or a one-click
// "Turn on sharing"); Unpaired and Room-full show neither.
function setStatus(state, text, sub, memberStates = false) {
	el.status.dataset.state = state;
	el.statusText.textContent = text;
	el.statusSub.textContent = sub;
	el.statusSub.hidden = !sub;

	el.sharingOn.hidden = !memberStates || !currentSharing;
	el.sharingTurnOn.hidden = !memberStates || currentSharing;
	updateSettingsRoomControls();
}

// One row per Buddy: swatch (matches their markers, so the popup doubles as the
// color legend), name, last-seen. A row new since the previous render springs in;
// existing rows stay motionless so the 5s poll stays calm.
function renderRoster(buddies, roster = buddies) {
	const ids = buddies.map((b) => b.clientId);
	const sameRoster = prevRosterIds !== null && ids.join('\n') === prevRosterIds.join('\n');
	// Keep an open picker up across a no-change poll; anything else closes it.
	if (!sameRoster) closeColorGrid();

	currentRosterBuddies = buddies;
	el.roster.textContent = '';
	for (const b of buddies) {
		const row = document.createElement('div');
		row.className = 'buddy';
		if (prevRosterIds !== null && !prevRosterIds.includes(b.clientId)) {
			row.classList.add('is-new');
		}

		const swatch = document.createElement('button');
		swatch.className = 'swatch';
		swatch.type = 'button';
		swatch.setAttribute('aria-label', `Change color for ${YTB.buddyName(b.clientId, b.name, roster)}`);
		const chip = document.createElement('span');
		chip.className = 'chip';
		chip.style.background = YTB.buddyColor(b.clientId);
		swatch.appendChild(chip);
		if (b.clientId === lastPickedBuddyId) {
			// One-shot wiggle on the swatch that just received a new color.
			swatch.classList.add('is-picked');
			lastPickedBuddyId = '';
		}
		// Stop propagation; toggle/re-anchor is handled explicitly here, not by the outside-click dismissal.
		swatch.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleColorGrid(b.clientId, swatch, row);
		});

		const name = document.createElement('span');
		name.className = 'buddy-name';
		name.textContent = YTB.buddyName(b.clientId, b.name, roster);

		const seen = document.createElement('span');
		seen.className = 'buddy-seen';
		seen.textContent = formatLastSeen(b.updatedAt);

		row.append(swatch, name, seen);
		el.roster.appendChild(row);
	}
	prevRosterIds = ids;
}

// Re-clicking the Buddy the picker is already open for closes it; a different Buddy re-anchors it instead.
function toggleColorGrid(clientId, anchorEl, rowEl) {
	const alreadyOpenForThis = !el.colorGrid.hidden && selectedBuddyId === clientId;
	if (alreadyOpenForThis) {
		closeColorGrid();
		return;
	}
	openColorGrid(clientId, anchorEl, rowEl);
}

function openColorGrid(clientId, anchorEl, rowEl) {
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
		chip.className = 'chip';
		chip.style.background = color;
		button.appendChild(chip);
		button.addEventListener('click', async () => {
			if (await YTB.setBuddyColor(activeRoomCode, selectedBuddyId, color)) {
				lastPickedBuddyId = selectedBuddyId;
				closeColorGrid();
				renderRoster(currentRosterBuddies, currentRoster);
			}
		});
		el.colorGrid.appendChild(button);
	}
	positionColorGrid(anchorEl, rowEl);
	el.colorGrid.querySelector('[aria-pressed="true"]')?.focus();
}

function closeColorGrid() {
	el.colorGrid.hidden = true;
	selectedBuddyId = '';
}

// Left-align to the clicked swatch, open below by default, flip above when the
// popup lacks room below (e.g. the last roster row).
function positionColorGrid(anchorEl, rowEl) {
	const anchorRect = anchorEl.getBoundingClientRect();
	const rowRect = rowEl.getBoundingClientRect();
	const gap = 4;
	el.colorGrid.hidden = false; // must be visible to measure its height below
	el.colorGrid.style.left = `${anchorRect.left}px`;
	const gridHeight = el.colorGrid.getBoundingClientRect().height;
	const fitsBelow = rowRect.bottom + gap + gridHeight <= window.innerHeight;
	el.colorGrid.style.top = fitsBelow ? `${rowRect.bottom + gap}px` : `${rowRect.top - gap - gridHeight}px`;
}

// Wall-clock "last seen" for updatedAt (ms epoch); YTB.formatTime is for video
// positions, not timestamps.
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
