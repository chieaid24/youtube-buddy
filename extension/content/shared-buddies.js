// extension/content/shared-buddies.js
// Buddy identity on window.YTB: Room Code normalization, viewer-local Buddy
// Colors (plus the ONE buddyColors storage subscription), display names, and
// the popup's roomView reduction.

(() => {
	const YTB = window.YTB;

	Object.assign(YTB, {
		// Canonical Room Code slug (lowercase, drop leading "the ", whitespace ->
		// hyphens) so the pretty label and typed/pasted form pair,
		// e.g. "The Silly Otters" -> "silly-otters".
		normalizeCode(raw) {
			return String(raw ?? '')
				.trim()
				.toLowerCase()
				.replace(/^the\s+/, '')
				.replace(/\s+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-+|-+$/g, '');
		},

		// Whether a Room has ever had at least one member record.
		roomExists(records) {
			return (records?.progress?.length || 0) + (records?.presence?.length || 0) > 0;
		},

		// Fixed colors for contrast on light popup/feed surfaces and YouTube's
		// dark player; at most four foreign Buddies, so spares remain.
		BUDDY_COLORS: ['#00a6d6', '#FFB812', '#8649d6', '#00a86b', '#ff8400', '#d936c7', '#d94141', '#4651e5'],
		_buddyColors: {},
		_activeRoomCode: '',

		async syncBuddyColors(code, buddyIds, successful, random = Math.random) {
			const stored = await YTB._storageGet('buddyColors');
			if (!YTB.isContextActive()) return {};
			const all = stored.buddyColors || {};
			const room = { ...(all[code] || {}) };
			if (successful) {
				const current = new Set(buddyIds);
				for (const id of Object.keys(room)) if (!current.has(id)) delete room[id];
				for (const id of buddyIds) {
					if (room[id]) continue;
					const used = new Set(Object.values(room));
					const available = YTB.BUDDY_COLORS.filter((color) => !used.has(color));
					room[id] = available[Math.floor(random() * available.length)];
				}
				all[code] = room;
				await YTB._storageSet({ buddyColors: all });
			}
			YTB._buddyColors = all;
			YTB._activeRoomCode = code;
			return room;
		},

		async setBuddyColor(code, clientId, color) {
			if (!YTB.BUDDY_COLORS.includes(color)) return false;
			const stored = await YTB._storageGet('buddyColors');
			if (!YTB.isContextActive()) return false;
			const all = stored.buddyColors || {};
			const room = { ...(all[code] || {}) };
			if (Object.entries(room).some(([id, assigned]) => id !== clientId && assigned === color)) return false;
			room[clientId] = color;
			all[code] = room;
			YTB._buddyColors = all;
			YTB._activeRoomCode = code;
			await YTB._storageSet({ buddyColors: all });
			return true;
		},

		async clearRoomColors(code) {
			const stored = await YTB._storageGet('buddyColors');
			if (!YTB.isContextActive()) return;
			const all = stored.buddyColors || {};
			delete all[code];
			YTB._buddyColors = all;
			await YTB._storageSet({ buddyColors: all });
		},

		// Playful adjectives for unnamed Buddies (buddyName); same-adjective
		// collisions within a Room are broken by disambiguateNames.
		ADJECTIVES: ['Silly', 'Sleepy', 'Sweaty', 'Big', 'Little', 'Buddy', 'Good-looking', 'Sloppy', 'Zesty', 'Stinky'],

		// Stable 32-bit hash of a Client ID, so everything keyed off a Buddy
		// (color, fallback name) stays stable across surfaces and viewers.
		hashClientId(clientId) {
			const s = String(clientId);
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
			return h;
		},

		// The viewer-local color assignment for a Buddy in a Room.
		buddyColor(clientId, code = YTB._activeRoomCode) {
			return (YTB._buddyColors[code] || {})[clientId] || YTB.BUDDY_COLORS[0];
		},

		// The Buddy Color as TEXT ink on an opaque card surface: raw fills miss
		// WCAG AA as small text, so blend toward the theme ink; over-video text,
		// dots, markers, and swatches keep the raw buddyColor.
		buddyTextColor(clientId, code = YTB._activeRoomCode) {
			return `color-mix(in oklab, ${YTB.buddyColor(clientId, code)} 50%, var(--ytb-ink))`;
		},

		// Base label without Room context: trimmed Display Name, else a stable
		// "<Adjective> Buddy". Collisions possible - user-facing code goes through
		// buddyName with a roster.
		baseBuddyName(clientId, name) {
			const trimmed = String(name ?? '').trim();
			if (trimmed) return trimmed;
			const adjs = YTB.ADJECTIVES;
			const h = YTB.hashClientId(clientId);
			return `${adjs[((h % adjs.length) + adjs.length) % adjs.length]} Buddy`;
		},

		// Room-unique labels: collisions ordered by Client ID, each successive
		// duplicate gaining a "Very " prefix ("Silly Buddy" / "Very Silly Buddy").
		// Deterministic across surfaces and viewers; applies to real names too.
		disambiguateNames(roster) {
			const groups = new Map(); // base label -> clientId[]
			for (const m of roster || []) {
				if (!m || !m.clientId) continue;
				const base = YTB.baseBuddyName(m.clientId, m.name);
				const ids = groups.get(base);
				if (ids) ids.push(m.clientId);
				else groups.set(base, [m.clientId]);
			}
			const labels = new Map();
			for (const [base, ids] of groups) {
				ids.sort();
				ids.forEach((id, i) => labels.set(id, 'Very '.repeat(i) + base));
			}
			return labels;
		},

		// Display label for a Buddy (FOREIGN records only - you never render
		// yourself as a Buddy); a roster enables disambiguation.
		buddyName(clientId, name, roster) {
			if (roster) return YTB.disambiguateNames(roster).get(clientId) || YTB.baseBuddyName(clientId, name);
			return YTB.baseBuddyName(clientId, name);
		},

		// Reduce a Room read into the popup's view: a Buddy is any FOREIGN
		// clientId, preferring their latest Progress Record over a presence-only
		// row; `locked` means the Room is full of OTHERS with me the rejected 6th.
		roomView(records, myClientId) {
			const progress = (records && records.progress) || [];
			const presence = (records && records.presence) || [];
			const notes = (records && records.notes) || [];

			const latestByBuddy = new Map(); // clientId -> latest progress record
			const presenceByBuddy = new Map(); // clientId -> presence row
			const noteByBuddy = new Map(); // clientId -> latest Note
			const memberIds = new Set(); // distinct clientIds across all sets (for the cap)
			let iAmMember = false;

			for (const r of progress) {
				if (!r || !r.clientId) continue;
				memberIds.add(r.clientId);
				if (r.clientId === myClientId) {
					iAmMember = true;
					continue;
				}
				const prev = latestByBuddy.get(r.clientId);
				if (!prev || r.updatedAt > prev.updatedAt) latestByBuddy.set(r.clientId, r);
			}
			for (const p of presence) {
				if (!p || !p.clientId) continue;
				memberIds.add(p.clientId);
				if (p.clientId === myClientId) {
					iAmMember = true;
					continue;
				}
				presenceByBuddy.set(p.clientId, p);
			}
			for (const note of notes) {
				if (!note || !note.clientId) continue;
				memberIds.add(note.clientId);
				if (note.clientId === myClientId) {
					iAmMember = true;
					continue;
				}
				const prev = noteByBuddy.get(note.clientId);
				if (!prev || note.createdAt > prev.createdAt) noteByBuddy.set(note.clientId, note);
			}

			// One entry per foreign Buddy: prefer their progress record (has a
			// position), else a presence-only row (joined, no videoId/timestamp).
			const buddyIds = new Set([...latestByBuddy.keys(), ...presenceByBuddy.keys(), ...noteByBuddy.keys()]);
			const buddies = [];
			for (const cid of buddyIds) {
				const prog = latestByBuddy.get(cid);
				if (prog) {
					buddies.push(prog);
				} else if (presenceByBuddy.has(cid)) {
					const p = presenceByBuddy.get(cid);
					buddies.push({
						clientId: p.clientId,
						name: p.name,
						updatedAt: p.updatedAt,
					});
				} else {
					const note = noteByBuddy.get(cid);
					buddies.push({
						clientId: note.clientId,
						name: note.name,
						updatedAt: note.createdAt,
					});
				}
			}
			buddies.sort((a, b) => b.updatedAt - a.updatedAt);

			// Distinct OTHERS; 5 with no membership of my own = a full Room I'd be
			// the locked-out 6th of.
			let foreignCount = 0;
			for (const id of memberIds) if (id !== myClientId) foreignCount++;
			const locked = !iAmMember && foreignCount >= YTB.MAX_MEMBERS;

			return { buddies, iAmMember, locked };
		},
	});

	// The ONE `buddyColors` storage subscription: refresh the cache
	// (load-order-independent) and rebroadcast `ytb:buddy-colors` for every
	// colored surface to repaint. The `document` guard lets the workerd test
	// harness just refresh the cache.
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.buddyColors) return;
		YTB._buddyColors = changes.buddyColors.newValue || {};
		if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('ytb:buddy-colors'));
	});
})();
