// Hidden extension-origin frame on YouTube Home: relays a request to open the real action popup,
// since the content script cannot reach chrome.action (ADR-0012). Renders and stores nothing.

(function () {
	'use strict';

	const OPEN_MESSAGE = 'ytb:open-control-panel';
	const OPEN_FAILED_MESSAGE = 'ytb:open-control-panel-failed';

	window.addEventListener('message', async (event) => {
		if (event.source !== window.parent || !isYouTubeOrigin(event.origin) || event.data?.type !== OPEN_MESSAGE) return;
		try {
			await chrome.action.openPopup();
		} catch {
			window.parent.postMessage({ type: OPEN_FAILED_MESSAGE }, event.origin);
		}
	});

	function isYouTubeOrigin(origin) {
		try {
			const url = new URL(origin);
			return (
				(url.protocol === 'https:' || url.protocol === 'http:') && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
			);
		} catch {
			return false;
		}
	}
})();
