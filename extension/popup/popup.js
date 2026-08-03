// popup.js -- identity, Room Code, and Sharing controls. Consumes shared.js's YTB
// contract; state persists in chrome.storage.local. See CONTEXT.md / DESIGN.md.

const ROSTER_POLL_MS = 5_000;

const el = {
	// Display Name (locked once set; the pencil reopens the input).
	nameField: document.getElementById('name-field'),
	name: document.getElementById('name'),
	nameValue: document.getElementById('name-value'),
	nameEdit: document.getElementById('name-edit'),
	// Room Code views (mutually exclusive).
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
	// Settings view (gear in the header).
	roomSection: document.getElementById('room-section'),
	viewSettings: document.getElementById('view-settings'),
	settingsOpen: document.getElementById('settings-open'),
	settingsBack: document.getElementById('settings-back'),
	themeSeg: document.getElementById('theme-seg'),
	edgePicker: document.getElementById('edge-picker'),
	setNotes: document.getElementById('set-notes'),
	setProgress: document.getElementById('set-progress'),
	setSpoiler: document.getElementById('set-spoiler'),
	settingsRoom: document.getElementById('settings-room'),
	settingsSharing: document.getElementById('settings-sharing'),
	// Confirm dialog.
	confirmOverlay: document.getElementById('confirm-overlay'),
	confirmTitle: document.getElementById('confirm-title'),
	confirmBody: document.getElementById('confirm-body'),
	confirmCancel: document.getElementById('confirm-cancel'),
	// One OK button (id kept as confirm-disconnect); label/variant set per-open.
	confirmOk: document.getElementById('confirm-disconnect'),
};

let myClientId = '';

// Pending confirm action; one dialog serves Leave room AND Stop sharing.
let pendingConfirm = null;

let currentSharing = true;

// Settings snapshot (YTB.getSettings keys); null until init reads storage.
let currentSettings = null;

// Room view to restore when Settings closes.
let settingsReturn = 'chooser';

// Last-rendered roster, so a Buddy Color change can redraw without a re-GET.
let currentRosterBuddies = [];
// Full Room roster (incl. me) from the last read, for Room-unique Buddy labels.
let currentRoster = [];
let selectedBuddyId = '';
let activeRoomCode = '';

// Consecutive Room-read failures (shared Connection Lost rule).
let connectionFailures = 0;

// Previous render's roster ids, so only new Buddy rows animate; null = no render yet.
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

	// A fresh install (blank name) opens in edit mode.
	setFieldLocked(el.nameField, !!config.name);

	// theme.js already stamped data-theme; just reflect stored prefs into controls.
	currentSettings = await YTB.getSettings();
	buildEdgePicker();
	renderSettingsControls();

	wireHandlers();
	setInterval(refreshConnectedRoom, ROSTER_POLL_MS);

	if (config.code) {
		showConnected(config.code);
		// Not awaited: a dead backend must not block Leave room; refreshes presence TTL.
		YTB.assertPresence(config.code);
		await refreshStatus(config.code);
	} else {
		showView('chooser');
	}
}

function wireHandlers() {
	// Persist every keystroke so closing the popup never loses input.
	el.name.addEventListener('input', () => {
		YTB.setConfig({ name: el.name.value });
	});

	// Enter/blur commits; there is no Save button.
	el.name.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') commitName();
	});
	el.name.addEventListener('blur', commitName);

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
		if (!code) return;
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

	el.leaveRoom.addEventListener('click', () => {
		confirmDisconnectThen(clearCodeAndChoose);
	});

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

	// Swatch clicks stop propagation (renderRoster), so only closing clicks land here.
	document.addEventListener('click', (e) => {
		if (el.colorGrid.hidden || el.colorGrid.contains(e.target)) return;
		closeColorGrid();
	});

	// Turn-ON is unguarded; the guarded stop lives in Settings.
	el.sharingTurnOn.addEventListener('click', () => setSharing(true));

	el.settingsOpen.addEventListener('click', () => {
		if (el.viewSettings.hidden) openSettings();
		else closeSettings();
	});
	el.settingsBack.addEventListener('click', () => closeSettings());

	for (const button of el.themeSeg.querySelectorAll('[data-theme-choice]')) {
		button.addEventListener('click', () => saveSettings({ theme: button.dataset.themeChoice }));
	}

	el.setNotes.addEventListener('click', () => saveSettings({ notesHidden: !currentSettings.notesHidden }));
	el.setProgress.addEventListener('click', () => saveSettings({ buddyProgressHidden: !currentSettings.buddyProgressHidden }));
	el.setSpoiler.addEventListener('click', () => saveSettings({ spoilerDefault: !currentSettings.spoilerDefault }));

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

	// Re-sync when a preference changes elsewhere.
	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area !== 'local' || !currentSettings) return;
		const keys = ['theme', 'spoilerDefault', 'notificationPosition', 'notesHidden', 'buddyProgressHidden'];
		if (!keys.some((key) => key in changes)) return;
		currentSettings = await YTB.getSettings();
		renderSettingsControls();
	});
}

function updateJoinSubmit() {
	const enabled = el.joinInput.value.trim().length > 0;
	el.joinSubmit.disabled = !enabled;
	el.joinSubmit.classList.toggle('btn-primary', enabled);
}

// --- Display Name lock/edit ---------------------------------------------------

// is-locked swaps the input for the value chip + pencil (CSS).
function setFieldLocked(field, locked) {
	field.classList.toggle('is-locked', locked);
}

function commitName() {
	const name = el.name.value.trim();
	el.name.value = name;
	el.nameValue.textContent = name;
	setFieldLocked(el.nameField, name.length > 0);
	// Re-assert presence so the new name propagates to Buddies (best-effort).
	YTB.setConfig({ name }).then(() =>
		YTB.getConfig().then(({ code }) => {
			if (code) YTB.assertPresence(code);
		}),
	);
}

// --- Room Code flows (create / join) -----------------------------------------

// Assert presence so I appear in the Room before watching anything.
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

// Verify the Room exists before committing config or leaving the old Room.
async function joinAndCommit() {
	const code = YTB.normalizeCode(el.joinInput.value);
	if (!code) return;
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

// One reusable confirm dialog; variant: "danger" = red Leave, "neutral" = Stop sharing.
function openConfirm({ title, body, confirmLabel, variant, onConfirm }) {
	el.confirmTitle.textContent = title;
	el.confirmBody.textContent = body;
	el.confirmOk.textContent = confirmLabel;
	el.confirmOk.className = 'btn ' + (variant === 'danger' ? 'btn-danger' : 'btn-neutral');
	pendingConfirm = onConfirm;
	showConfirm();
}

// Opens on local state alone, so leaving works while the backend is unreachable;
// the buddy-names copy is best-effort enrichment once the read lands.
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

// Clear local state first -- an unreachable backend must not trap the viewer;
// TTL cleans up if the DELETE never lands.
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

// Buddy names for the confirm copy, labelled the same way the roster is.
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

function openSettings() {
	settingsReturn = !el.viewConnected.hidden ? 'connected' : !el.viewJoin.hidden ? 'join' : 'chooser';
	showView('settings');
}

// Connected re-routes through a real GET since state may have changed in Settings.
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

// A theme change also stamps data-theme here, mirroring theme.js's cross-tab onChanged listener.
function saveSettings(partial) {
	if (!currentSettings) return;
	currentSettings = { ...currentSettings, ...partial };
	renderSettingsControls();
	if ('theme' in partial) {
		if (partial.theme === 'light' || partial.theme === 'dark') document.documentElement.setAttribute('data-theme', partial.theme);
		else document.documentElement.removeAttribute('data-theme');
	}
	YTB.setSettings(partial);
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

function setSwitch(row, on) {
	row.setAttribute('aria-checked', String(on));
}

// Visibility rows read as "shown" switches: checked is the inverse of the stored *Hidden keys.
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
	updateSettingsRoomControls();
}

function updateSettingsRoomControls() {
	el.settingsRoom.hidden = !activeRoomCode;
	setSwitch(el.settingsSharing, currentSharing);
}

// --- view switching ----------------------------------------------------------

// Show exactly one view; re-unhiding restarts its CSS enter animation.
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

function showConnected(code) {
	el.code.textContent = YTBRoomCode.pretty(code);
	showView('connected');
}

// States: Unpaired, Waiting, In room, or Room full (I'm the locked-out 6th).
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

// Only member states (waiting/in-room) show the Sharing line or Turn-on button.
function setStatus(state, text, sub, memberStates = false) {
	el.status.dataset.state = state;
	el.statusText.textContent = text;
	el.statusSub.textContent = sub;
	el.statusSub.hidden = !sub;

	el.sharingOn.hidden = !memberStates || !currentSharing;
	el.sharingTurnOn.hidden = !memberStates || currentSharing;
	updateSettingsRoomControls();
}

// Swatches match Buddy markers, so the popup doubles as the color legend;
// only rows new since the last render animate, keeping the 5s poll calm.
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
		// Keep swatch clicks out of the outside-click dismissal.
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

// Open below the clicked swatch; flip above when the popup lacks room below.
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

// Wall-clock "last seen"; YTB.formatTime is for video positions, not epochs.
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
