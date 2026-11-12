const OPEN_ROOM_MESSAGE = 'ytb:open-room-home';
const ROOM_URL = 'https://www.youtube.com/#ytb-room';
const EXISTING_TAB_TIMEOUT_MS = 500;

const el = {
	openRoom: document.getElementById('your-room'),
	feedback: document.getElementById('launch-feedback'),
};

el.openRoom.addEventListener('click', openYourRoom);

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
	el.openRoom.textContent = 'Opening your room...';
	el.openRoom.setAttribute('aria-busy', 'true');
	el.feedback.textContent = '';
	try {
		const [active] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		if (active && active.id != null && isYouTubeHome(active.url) && (await openExistingRoom(active.id))) {
			window.close();
			return;
		}

		await chrome.tabs.create({ url: ROOM_URL, active: true });
		window.close();
	} catch {
		el.feedback.textContent = "Couldn't open Your Room. Try again.";
		el.openRoom.disabled = false;
		el.openRoom.textContent = 'Check out your room!';
		el.openRoom.removeAttribute('aria-busy');
	}
}

async function openExistingRoom(tabId) {
	let timeout;
	try {
		const response = await Promise.race([
			chrome.tabs.sendMessage(tabId, { type: OPEN_ROOM_MESSAGE }),
			new Promise((resolve) => {
				timeout = setTimeout(() => resolve(null), EXISTING_TAB_TIMEOUT_MS);
			}),
		]);
		return Boolean(response && response.opened);
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}
