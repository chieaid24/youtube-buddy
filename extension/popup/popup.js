const ROSTER_POLL_MS = 5_000;
const OPEN_ROOM_MESSAGE = 'ytb:open-room-home';
const HOME_URL = 'https://www.youtube.com/';

const el = {
	state: document.getElementById('room-state'),
	code: document.getElementById('room-code'),
	buddies: document.getElementById('buddy-count'),
	sharing: document.getElementById('sharing-state'),
	connection: document.getElementById('connection-state'),
	openRoom: document.getElementById('your-room'),
	feedback: document.getElementById('launch-feedback'),
};

let myClientId = '';
let readFailures = 0;
let lastStatus = null;

init();

async function init() {
	myClientId = await YTB.ensureClientId();
	el.openRoom.addEventListener('click', openYourRoom);
	await refreshStatus();
	setInterval(refreshStatus, ROSTER_POLL_MS);
}

async function refreshStatus() {
	const config = await YTB.getConfig();
	if (!config.code) {
		readFailures = 0;
		renderStatus({ state: 'Unpaired', code: 'Not paired', buddies: 0, sharing: config.sharing, connectionLost: false });
		return;
	}

	const records = await YTB.getRecords(config.code);
	const connection = YTB.connectionState(readFailures, records.ok);
	readFailures = connection.failures;
	if (!records.ok) {
		const retained = lastStatus || { state: 'Connecting', code: YTBRoomCode.pretty(config.code), buddies: 0 };
		renderStatus({ ...retained, sharing: config.sharing, connectionLost: connection.lost });
		return;
	}

	const view = YTB.roomView(records, myClientId);
	const status = {
		state: view.locked ? 'Room full' : view.buddies.length ? 'In room' : 'Waiting',
		code: YTBRoomCode.pretty(config.code),
		buddies: view.buddies.length,
		sharing: config.sharing,
		connectionLost: false,
	};
	lastStatus = status;
	renderStatus(status);
}

function renderStatus(status) {
	el.state.textContent = status.state;
	el.code.textContent = status.code;
	el.buddies.textContent = String(status.buddies);
	el.sharing.textContent = status.sharing ? 'On' : 'Off';
	el.connection.hidden = !status.connectionLost;
}

function isYouTubeHome(url) {
	try {
		const parsed = new URL(url);
		return (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) && parsed.pathname === '/';
	} catch {
		return false;
	}
}

async function openYourRoom() {
	if (el.openRoom.disabled) return;
	el.openRoom.disabled = true;
	el.feedback.textContent = '';
	try {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (active && active.id != null && isYouTubeHome(active.url)) {
			await waitForRoomHome(active.id);
			return;
		}

		const target = await chrome.tabs.create({ url: HOME_URL, active: false });
		if (target.id == null) throw new Error('Missing target tab');
		await waitForRoomHome(target.id);
		await chrome.tabs.update(target.id, { active: true });
	} catch {
		el.feedback.textContent = "Couldn't open Your Room. Try again.";
		el.openRoom.disabled = false;
	}
}

async function waitForRoomHome(tabId) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await chrome.tabs.sendMessage(tabId, { type: OPEN_ROOM_MESSAGE });
			if (response && response.opened) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Room Home did not become ready');
}
