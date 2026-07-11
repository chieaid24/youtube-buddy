// popup.js -- identity, Room Code, and the Sharing pill.
// Consumes the frozen `window.YTB` contract from shared.js. The popup is the only
// UI surface; all persisted state lives in chrome.storage.local (via YTB) so it
// survives a browser restart. See CONTEXT.md for terminology and DESIGN.md for the
// visual system this file drives.

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
	// The single confirm/OK button (id kept as confirm-disconnect); its label and
	// variant are set per-open by openConfirm.
	confirmOk: document.getElementById('confirm-disconnect'),
};

let myClientId = '';

// The action to run if the open confirm dialog is confirmed (set per-open;
// cleared on cancel/confirm). One dialog serves Leave room AND Stop sharing.
let pendingConfirm = null;

// Last-known Sharing state.
let currentSharing = true;

// The Settings snapshot driving the Settings controls: the five YTB.getSettings
// keys plus homeSectionHidden (which keeps its own storage seam). null until
// init has read storage.
let currentSettings = null;

// The room view to land on when Settings closes (Back or the gear again).
let settingsReturn = 'chooser';

// Last-rendered roster, so a Buddy Color change can redraw without a re-GET.
let currentRosterBuddies = [];
// Full Room roster (incl. me) from the last read, for Room-unique Buddy labels.
let currentRoster = [];
let selectedBuddyId = '';
let activeRoomCode = '';

// Roster ids from the previous render: lets a genuinely NEW Buddy row animate in
// while the 5s poll re-render keeps existing rows perfectly still. null = no
// render yet (the initial fill does not animate row-by-row).
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

	// The Display Name starts locked iff it already holds a non-empty committed
	// value, so a fresh install (blank name) opens in edit mode (onboarding unchanged).
	setFieldLocked(el.nameField, !!config.name);

	// Settings: read the stored preferences once, build the zone picker, and
	// reflect everything into the controls (theme.js already stamped data-theme).
	currentSettings = {
		...(await YTB.getSettings()),
		homeSectionHidden: await YTB.getHomeSectionHidden(),
	};
	buildEdgePicker();
	renderSettingsControls();

	wireHandlers();
	setInterval(refreshConnectedRoom, ROSTER_POLL_MS);

	// Route to the right view: an active code -> Connected (refresh status with a
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
	// loses input. Name collisions are harmless -- identity is the Client ID.
	el.name.addEventListener('input', () => {
		YTB.setConfig({ name: el.name.value });
	});

	// Name commit: Enter or blur turns the editable name into a locked chip. There
	// is no Save button -- unfocusing the field (or pressing Enter) just saves.
	el.name.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') commitName();
	});
	el.name.addEventListener('blur', commitName);

	// The pencil icon is unguarded (cosmetic) -> reopen the input immediately.
	el.nameEdit.addEventListener('click', () => {
		setFieldLocked(el.nameField, false);
		el.name.focus();
	});

	// Chooser -> Create: mint + commit a fresh code immediately (no confirm step).
	el.chooseCreate.addEventListener('click', () => createAndCommit());

	// Chooser -> Join: switch to the free-text entry view.
	el.chooseJoin.addEventListener('click', () => {
		el.joinInput.value = '';
		updateJoinSubmit();
		showView('join');
		el.joinInput.focus();
	});

	// Chooser -> Cancel: only reachable when a code already exists; return to
	// Connected without touching the active code.
	el.chooserCancel.addEventListener('click', async () => {
		const { code } = await YTB.getConfig();
		if (!code) return; // No active code -- nothing to cancel back to.
		showConnected(code);
		await refreshStatus(code);
	});

	// Join -> submit: normalize (trim + lowercase) and commit verbatim. Pure match --
	// no word-list validation; pairing succeeds only if it matches a real code.
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

	// Connected -> Copy: use the exact rendered label as the clipboard source of
	// truth and announce anchored success/failure feedback. The button is native
	// keyboard-accessible.
	el.copyCode.addEventListener('click', async () => {
		const text = el.code.textContent;
		if (!text) return;
		await YTBRoomCode.copy({
			text,
			feedback: el.copyFeedback,
			button: el.copyCode,
		});
	});

	// Connected -> Leave room: the explicit "leave this room" action. Always
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
		if (e.key !== 'Escape') return;
		if (!el.confirmOverlay.hidden) hideConfirm();
		else if (!el.colorGrid.hidden) closeColorGrid();
	});

	// Color picker dismiss: same "click anywhere else" pattern as the confirm
	// dialog. Swatch clicks stop propagation (see renderRoster) so they never
	// reach here -- this only ever sees clicks that should close the picker.
	document.addEventListener('click', (e) => {
		if (el.colorGrid.hidden || el.colorGrid.contains(e.target)) return;
		closeColorGrid();
	});

	// Starting Sharing is instant and unguarded; the main view only ever offers
	// the turn-ON (the guarded stop lives in Settings). The reporter reads
	// `sharing` and stops/resumes its POSTs; the renderer keeps drawing the
	// Buddy either way.
	el.sharingTurnOn.addEventListener('click', () => setSharing(true));

	// Settings: the gear toggles the view open/closed; Back returns to the
	// room view that was showing when it opened.
	el.settingsOpen.addEventListener('click', () => {
		if (el.viewSettings.hidden) openSettings();
		else closeSettings();
	});
	el.settingsBack.addEventListener('click', () => closeSettings());

	// Theme Preference: persist and stamp data-theme immediately (theme.js's
	// storage.onChanged listener does the same in every open YouTube tab).
	for (const button of el.themeSeg.querySelectorAll('[data-theme-choice]')) {
		button.addEventListener('click', () => saveSettings({ theme: button.dataset.themeChoice }));
	}

	// Visibility + Spoiler Default toggle rows (each stores its documented key).
	el.setNotes.addEventListener('click', () => saveSettings({ notesHidden: !currentSettings.notesHidden }));
	el.setProgress.addEventListener('click', () => saveSettings({ buddyProgressHidden: !currentSettings.buddyProgressHidden }));
	el.setSpoiler.addEventListener('click', () => saveSettings({ spoilerDefault: !currentSettings.spoilerDefault }));
	el.setHome.addEventListener('click', () => saveSettings({ homeSectionHidden: !currentSettings.homeSectionHidden }));

	// Room actions relocated into Settings: stopping keeps its confirm dialog,
	// starting stays instant.
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

	// Keep the Settings controls honest when a preference changes elsewhere
	// while the popup is open (e.g. the Room Home Toggle in YouTube's guide).
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

// Keep the Join action unavailable and neutral until there is meaningful input;
// with input it promotes to the apricot primary.
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

// Join flow: verify that the typed Room already has a member, then commit it,
// assert my presence, and refresh status. The existence read must happen before
// any local config or old-Room membership changes.
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

// One reusable confirm dialog. Callers set the copy, the confirm button's label
// and variant ("danger" = red Leave; "neutral" = warm charcoal Stop sharing), and
// the action to run on confirm.
function openConfirm({ title, body, confirmLabel, variant, onConfirm }) {
	el.confirmTitle.textContent = title;
	el.confirmBody.textContent = body;
	el.confirmOk.textContent = confirmLabel;
	el.confirmOk.className = 'btn ' + (variant === 'danger' ? 'btn-danger' : 'btn-neutral');
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

// Toggle Sharing and re-render the pill. Off stops our POSTs (reporter reads the
// flag); the renderer keeps drawing the Buddy's markers either way.
async function setSharing(on) {
	currentSharing = on;
	await YTB.setConfig({ sharing: on });
	const { code } = await YTB.getConfig();
	await refreshStatus(code);
}

// Confirmed disconnect via Leave room (now in Settings). Remove membership
// server-side before clearing local state so the Room slot and Buddy markers
// are released; landing on the chooser also closes the Settings view.
async function clearCodeAndChoose() {
	const { code: oldCode } = await YTB.getConfig();
	await YTB.setConfig({ code: '' });
	if (oldCode) {
		await YTB.deleteMember(oldCode, myClientId);
		await YTB.clearRoomColors(oldCode);
	}
	el.code.textContent = '';
	activeRoomCode = '';
	updateSettingsRoomControls();
	showView('chooser');
}

// Buddy Display Names under `code` for the confirmation, via the shared roomView
// (same dedup-by-Client-ID the roster uses); an unnamed buddy falls back to a
// stable "<Adjective> Buddy" (YTB.buddyName), matching the roster and on-page
// tooltips. Room-full lockout is irrelevant here -- I am already a member.
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

// Back: return to the room view Settings was opened from. Connected re-routes
// through a real GET (state may have changed while in Settings); a cleared
// code (left the room from Settings) falls back to the chooser.
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

// Merge-persist a Settings change and reflect it into the controls at once.
// homeSectionHidden keeps its dedicated storage seam (shared with the guide
// toggle); everything else goes through YTB.setSettings. A theme choice also
// stamps data-theme on this document immediately — theme.js's onChanged
// listener restyles every open YouTube tab (and would restyle us too, this is
// just the zero-latency path).
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

// The four Notification Position edges, in reading order so tab order matches
// the plus layout the CSS paints on the monitor.
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

// Reflect currentSettings into every Settings control. The visibility rows
// read as "shown" switches, so their checked state is the INVERSE of the
// stored *Hidden keys.
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

// The Room group in Settings: hidden while Unpaired; the sharing button
// mirrors the current state (guarded stop / instant start).
function updateSettingsRoomControls() {
	el.settingsRoom.hidden = !activeRoomCode;
	el.settingsSharing.textContent = currentSharing ? 'Stop sharing' : 'Start sharing';
	el.settingsSharing.className = 'btn ' + (currentSharing ? 'btn-neutral' : 'btn-primary');
}

// --- view switching ----------------------------------------------------------

// Show exactly one of the four views (chooser / join / connected / settings).
// Re-unhiding a view restarts its CSS enter animation (fade + 6px rise). The
// Cancel link in the chooser only makes sense when an active code exists
// (reached via "Leave room").
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

// Render the Connected view for an active code, showing its pretty label. The
// copy button is always available (created or joined).
function showConnected(code) {
	el.code.textContent = YTBRoomCode.pretty(code);
	showView('connected');
}

// Room status, from my perspective (a Room Code is one Room of up to
// YTB.MAX_MEMBERS people):
//   Unpaired      -- no code.
//   Waiting       -- code set, but no Buddy has a record yet.
//   In room       -- 1+ Buddies; list each with their color swatch + last-seen.
//   Room full     -- 5 others already, I'm not one of them (the locked-out 6th).
async function refreshStatus(code) {
	if (!code) {
		activeRoomCode = '';
		setStatus('unpaired', 'Unpaired', 'Enter or generate a Room Code to join.');
		renderRoster([]);
		return;
	}

	const { sharing } = await YTB.getConfig();
	currentSharing = sharing;
	const records = await YTB.getRecords(code);
	const { buddies, locked } = YTB.roomView(records, myClientId);
	currentRoster = YTB.roomRoster(records);
	activeRoomCode = code;
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

// Render the status panel. Waiting and in-room states show the Sharing state:
// a muted read-only "Sharing on" line while on (the guarded stop lives in
// Settings), or a prominent one-click "Turn on sharing" while off. Unpaired
// and Room-full states show neither.
function setStatus(state, text, sub, memberStates = false) {
	el.status.dataset.state = state;
	el.statusText.textContent = text;
	el.statusSub.textContent = sub;
	el.statusSub.hidden = !sub;

	el.sharingOn.hidden = !memberStates || !currentSharing;
	el.sharingTurnOn.hidden = !memberStates || currentSharing;
	updateSettingsRoomControls();
}

// Render one row per Buddy: [color swatch] name ... last-seen. The swatch square
// matches that Buddy's markers/segments (YTB.buddyColor), so the popup doubles
// as the color legend. Newest-active Buddy first (roomView already sorts).
// A row whose Client ID was not in the previous render springs in; rows that
// were already there re-render in place with no motion (the 5s poll stays calm).
function renderRoster(buddies, roster = buddies) {
	const ids = buddies.map((b) => b.clientId);
	const sameRoster = prevRosterIds !== null && ids.join('\n') === prevRosterIds.join('\n');
	// Keep an open picker up across a no-change poll; anything else invalidates
	// its anchor, so close it.
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
		// Stop this from also reaching the document-level outside-click dismissal
		// -- toggle/re-anchor is handled explicitly here.
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

// Toggle: re-clicking the Buddy the picker is already open for closes it;
// clicking a different Buddy re-anchors and repopulates for them instead.
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

// Left-align the popover to the clicked swatch and open it directly below
// that row by default, flipping above when the popup doesn't have enough
// remaining space below (e.g. the last roster row).
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

// Wall-clock "last seen" for a record's updatedAt (ms epoch). YTB.formatTime is
// for video positions, not timestamps, so format relative time here.
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

// --- In-page Control Panel overlay: report content height to the host ---
// When popup.html is embedded as the overlay iframe (home-toggle.js), the host
// YouTube page can't read our height across the extension/page origin boundary,
// so we post it and let the host size the iframe snugly for the current view.
// Inert in the toolbar popup, where window.parent === window and nothing here
// listens for the message.
(function reportPanelHeight() {
	if (window.parent === window) return;
	const post = () => {
		const height = Math.ceil(document.body.getBoundingClientRect().height);
		window.parent.postMessage({ type: 'ytb:panel-height', height }, '*');
	};
	new ResizeObserver(post).observe(document.body);
	post();
})();
