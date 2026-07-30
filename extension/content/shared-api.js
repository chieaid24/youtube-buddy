// extension/content/shared-api.js
// The API client on window.YTB (talks to BACKEND_URL). Code ownership:
// getRecords(code) takes code as an arg; the write paths read it from config
// (already-normalized, passed through verbatim).

(() => {
	const YTB = window.YTB;

	Object.assign(YTB, {
		// POST this user's current Progress Record (server sets updatedAt);
		// tolerates failure silently per the PRD.
		async postProgress({ clientId, name, videoId, timestamp, duration }) {
			const { code } = await YTB.getConfig();
			if (!code) return false; // Unpaired — nothing to share.
			try {
				const res = await fetch(YTB.BACKEND_URL + '/?code=' + encodeURIComponent(code), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						clientId,
						name,
						videoId,
						timestamp,
						duration,
					}),
				});
				return res.ok ? { ok: true } : false;
			} catch {
				return false;
			}
		},

		// GET everything live under `code` (server does no filtering; consumers
		// split mine vs Buddies' by clientId). Resolves to empty arrays with
		// ok:false on any failure so callers never null-check.
		async getRecords(code) {
			const empty = {
				progress: [],
				presence: [],
				notes: [],
				replies: [],
				playlist: [],
				events: [],
				ok: false,
			};
			try {
				const res = await fetch(YTB.BACKEND_URL + '/?code=' + encodeURIComponent(code));
				if (!res.ok) {
					// A silent non-2xx would be an untraceable total Buddy blackout - warn.
					console.warn('[youtube-buddy] getRecords: backend GET returned HTTP', res.status, '- rendering no Buddies this cycle');
					return empty;
				}
				const data = await res.json();
				return {
					progress: Array.isArray(data && data.progress) ? data.progress : [],
					presence: Array.isArray(data && data.presence) ? data.presence : [],
					notes: Array.isArray(data && data.notes) ? data.notes : [],
					replies: Array.isArray(data && data.replies) ? data.replies : [],
					playlist: Array.isArray(data && data.playlist) ? data.playlist : [],
					events: Array.isArray(data && data.events) ? data.events : [],
					ok: true,
				};
			} catch (err) {
				console.warn('[youtube-buddy] getRecords: backend GET failed -', err);
				return empty;
			}
		},

		// Delete one of this install's Notes; ownership-checked by the server.
		async deleteNote(code, clientId, id) {
			if (!code || !clientId || !id) return false;
			try {
				const query = new URLSearchParams({ code, clientId, id });
				const res = await fetch(YTB.BACKEND_URL + '/notes?' + query, {
					method: 'DELETE',
				});
				return res.ok ? { ok: true } : false;
			} catch {
				return false;
			}
		},

		// POST JSON, normalized to { ok: true, ...body } or { ok: false, category }
		// (network/unexpected); callers branch on category, never prose.
		async _postJson(pathAndQuery, payload) {
			try {
				const res = await fetch(YTB.BACKEND_URL + pathAndQuery, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const data = await res.json().catch(() => null);
				if (!data || typeof data !== 'object') return { ok: false, category: 'unexpected' };
				if (res.ok) return { ok: true, ...(data || {}) };
				return { ok: false, category: (data && data.category) || 'unexpected' };
			} catch {
				return { ok: false, category: 'network' };
			}
		},

		// Post a text Note or curated-emoji Reaction. Requires a Room Code;
		// Sharing does NOT gate Note writes (CONTEXT.md). videoTitle is captured
		// at post time (watchTitle) and never required.
		async postNote({ clientId, name, videoId, videoTitle, timestamp, kind, body, spoiler, mentions }) {
			const { code } = await YTB.getConfig();
			if (!code) return { ok: false, category: 'unpaired' };
			return YTB._postJson('/notes?code=' + encodeURIComponent(code), {
				clientId,
				name,
				videoId,
				timestamp,
				kind,
				body,
				spoiler,
				...(typeof videoTitle === 'string' && videoTitle !== '' ? { videoTitle } : {}),
				// Mentions are roster Client IDs (ADR-0006); omitted entirely when empty.
				...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
			});
		},

		// Post a Reply to an existing text Note (categories: reply_cap,
		// missing_parent, room_full).
		async postReply({ clientId, name, noteId, body, mentions }) {
			const { code } = await YTB.getConfig();
			if (!code) return { ok: false, category: 'unpaired' };
			return YTB._postJson('/replies?code=' + encodeURIComponent(code), {
				clientId,
				name,
				noteId,
				body,
				...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
			});
		},

		// Recommend a video to the Room (ADR-0007; API keeps the playlist name).
		// NOT gated by Sharing; re-adding is a server no-op returning the item.
		async postPlaylistAdd({ clientId, name, videoId, title }) {
			const { code } = await YTB.getConfig();
			if (!code) return { ok: false, category: 'unpaired' };
			return YTB._postJson('/playlist?code=' + encodeURIComponent(code), {
				clientId,
				name,
				videoId,
				title,
			});
		},

		// Un-recommend for everyone (ADR-0007): idempotent point delete,
		// server-permissive to any member; emits no Playlist Event.
		async deletePlaylistItem({ clientId, videoId }) {
			const { code } = await YTB.getConfig();
			if (!code || !clientId || !videoId) return { ok: false, category: 'validation' };
			try {
				const query = new URLSearchParams({ code, clientId, videoId });
				const res = await fetch(YTB.BACKEND_URL + '/playlist?' + query, {
					method: 'DELETE',
				});
				if (res.ok) return { ok: true };
				const data = await res.json().catch(() => null);
				return { ok: false, category: (data && data.category) || 'unexpected' };
			} catch {
				return { ok: false, category: 'network' };
			}
		},

		// Focused conversation read (parent + Replies oldest-first) for the open
		// Expanded Note's 5s poll; missing_parent means the Note was deleted.
		async getConversation(code, noteId) {
			if (!code || !noteId) return { ok: false, category: 'validation' };
			try {
				const query = new URLSearchParams({ code, noteId });
				const res = await fetch(YTB.BACKEND_URL + '/conversation?' + query);
				const data = await res.json().catch(() => null);
				if (res.ok && data && data.note) {
					return {
						ok: true,
						note: data.note,
						replies: Array.isArray(data.replies) ? data.replies : [],
					};
				}
				return { ok: false, category: (data && data.category) || 'unexpected' };
			} catch {
				return { ok: false, category: 'unexpected' };
			}
		},

		// Announce "I'm here" under `code`, independent of watching/Sharing;
		// idempotent upsert doubling as a keep-alive.
		async assertPresence(code) {
			if (!code) return false; // Unpaired — nobody to appear to.
			const { name } = await YTB.getConfig();
			const clientId = await YTB.ensureClientId();
			if (!YTB.isContextActive()) return false;
			try {
				const res = await fetch(YTB.BACKEND_URL + '/presence?code=' + encodeURIComponent(code), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ clientId, name }),
				});
				return res.ok ? { ok: true } : false;
			} catch {
				return false;
			}
		},

		// Remove my membership from `code`; best-effort, records TTL out on failure.
		async deleteMember(code, clientId) {
			if (!code || !clientId) return false;
			try {
				const res = await fetch(
					YTB.BACKEND_URL + '/member?code=' + encodeURIComponent(code) + '&clientId=' + encodeURIComponent(clientId),
					{
						method: 'DELETE',
					},
				);
				return res.ok ? { ok: true } : false;
			} catch {
				return false;
			}
		},

		// Fold one Room-read outcome into a poller's consecutive-failure state;
		// pollers own the counter, this only defines the shared threshold.
		connectionState(prevFailures, ok) {
			const failures = ok ? 0 : Math.max(0, Math.floor(Number(prevFailures) || 0)) + 1;
			return { failures, lost: failures >= 2 };
		},
	});
})();
