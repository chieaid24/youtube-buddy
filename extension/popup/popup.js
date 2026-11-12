const OPEN_ROOM_MESSAGE = 'ytb:open-room-home';
const HOME_URL = 'https://www.youtube.com/';

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
	el.feedback.textContent = '';
	try {
		const [active] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		if (active && active.id != null && isYouTubeHome(active.url)) {
			await waitForRoomHome(active.id);
			window.close();
			return;
		}

		const target = await chrome.tabs.create({ url: HOME_URL, active: false });
		if (target.id == null) throw new Error('Missing target tab');
		await waitForRoomHome(target.id);
		await chrome.tabs.update(target.id, { active: true });
		window.close();
	} catch {
		el.feedback.textContent = "Couldn't open Your Room. Try again.";
		el.openRoom.disabled = false;
	}
}

async function waitForRoomHome(tabId) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await chrome.tabs.sendMessage(tabId, {
				type: OPEN_ROOM_MESSAGE,
			});
			if (response && response.opened) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Room Home did not become ready');
}
