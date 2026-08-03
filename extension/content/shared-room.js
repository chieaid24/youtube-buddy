// extension/content/shared-room.js
// Room Home helpers on window.YTB: roster, Room Feed, Watched-By, the
// Recommended-for-you set (ADR-0007) and the Unseen set (ADR-0010) - pure
// derivations plus their Room-scoped local storage.

(() => {
	const YTB = window.YTB;

	Object.assign(YTB, {
		// One roster entry per distinct Client ID across every record kind,
		// carrying their latest nonblank Display Name, newest activity first.
		roomRoster(records) {
			const byId = new Map(); // clientId -> { clientId, name, nameAt, at }
			const consider = (clientId, name, at) => {
				if (!clientId) return;
				const t = Number(at) || 0;
				let entry = byId.get(clientId);
				if (!entry) {
					entry = { clientId, name: '', nameAt: -1, at: 0 };
					byId.set(clientId, entry);
				}
				if (t > entry.at) entry.at = t;
				// Only a record that carries a name can update it; Events are
				// nameless and must never blank out a known Display Name.
				if (typeof name === 'string' && name.trim() !== '' && t > entry.nameAt) {
					entry.name = name.trim();
					entry.nameAt = t;
				}
			};
			for (const r of (records && records.progress) || []) consider(r.clientId, r.name, r.updatedAt);
			for (const p of (records && records.presence) || []) consider(p.clientId, p.name, p.updatedAt);
			for (const n of (records && records.notes) || []) consider(n.clientId, n.name, n.createdAt);
			for (const reply of (records && records.replies) || []) consider(reply.clientId, reply.name, reply.createdAt);
			for (const item of (records && records.playlist) || []) consider(item.addedBy, item.addedByName, item.addedAt);
			for (const event of (records && records.events) || []) consider(event.actorClientId, undefined, event.at);
			return [...byId.values()].sort((a, b) => b.at - a.at).map(({ clientId, name }) => ({ clientId, name }));
		},

		// Fuzzy-search the roster for @-mention autocomplete: prefix, then
		// substring, then in-order subsequence ("sly" finds "Silly Buddy"); ties
		// keep roster order, empty query returns everything.
		filterRoster(roster, query) {
			const q = String(query ?? '')
				.trim()
				.toLowerCase();
			const isSubsequence = (needle, haystack) => {
				let i = 0;
				for (const ch of haystack) if (ch === needle[i]) i++;
				return i >= needle.length;
			};
			const scored = [];
			(roster || []).forEach((member, index) => {
				const label = YTB.buddyName(member.clientId, member.name, roster).toLowerCase();
				let rank;
				if (!q || label.startsWith(q)) rank = 0;
				else if (label.includes(q)) rank = 1;
				else if (isSubsequence(q, label)) rank = 2;
				else return;
				scored.push({ member, rank, index });
			});
			scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
			return scored.map((s) => s.member);
		},

		// Stored Mention Client ID -> current Display Name for inline "@Bob";
		// falls back to the stable Adjective-Buddy token, never a raw Client ID (ADR-0006).
		mentionName(roster, clientId) {
			const member = (roster || []).find((m) => m.clientId === clientId);
			return YTB.buddyName(clientId, member && member.name, roster);
		},

		// The watch page's video title, read wherever a record freezes one in.
		// `doc` is passed in (this file also loads in the popup, which has no player).
		watchTitle(doc) {
			const heading = doc.querySelector('ytd-watch-metadata h1');
			const text = heading && heading.textContent ? heading.textContent.trim() : '';
			return text || doc.title.replace(/ - YouTube$/, '').trim();
		},

		// Feed context fragment for a reply/mention row's Note: `on "Title"`, or
		// '' with no title. Plain text, never a link.
		videoContext(note) {
			const title = note && typeof note.videoTitle === 'string' ? note.videoTitle.trim() : '';
			return title === '' ? '' : 'on "' + title + '"';
		},

		// Tooltip for a Feed link opening a watch page; the fallback mirrors the
		// link's own "a video" label.
		titleLinkTooltip(title) {
			const trimmed = typeof title === 'string' ? title.trim() : '';
			return trimmed === '' ? 'Watch this video' : 'Watch "' + trimmed + '"';
		},

		// Render plan for one recommend System Message row; home-section.js
		// executes it. A struck line (`removed`) has NO link - the sole exception
		// to the Feed's link rule - and carries a tooltip + visually-hidden
		// suffix, since a line-through alone conveys nothing to a screen reader.
		systemLine(item, roster) {
			const event = (item && item.event) || {};
			const struck = Boolean(item && item.removed);
			const linked = !struck && Boolean(event.videoId);
			return {
				struck,
				prefix: item && item.own ? 'You recommended ' : YTB.mentionName(roster, event.actorClientId) + ' recommended ',
				label: event.title || 'a video',
				suffix: item && item.own ? ' to the Room' : '',
				linkVideoId: linked ? event.videoId : null,
				linkTooltip: linked ? YTB.titleLinkTooltip(event.title) : null,
				rowTooltip: struck ? 'No longer recommended' : null,
				srSuffix: struck ? ' (no longer recommended)' : null,
			};
		},

		// "Watched by" attribution for one video: "You" first, then up to two
		// Buddy names most-recent first, then "and N other(s)"; '' if nobody has
		// a record. `buddiesOnly` (the Watched-By Dots tooltip) drops "You" -
		// that's YouTube's own red Watched Bar's to tell.
		watchedByLabel(progress, videoId, myClientId, roster, { buddiesOnly = false } = {}) {
			const latest = new Map(); // clientId -> latest record (for its name)
			for (const r of progress || []) {
				if (!r || !r.clientId || r.videoId !== videoId) continue;
				const prev = latest.get(r.clientId);
				if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.clientId, r);
			}
			const parts = [];
			if (latest.has(myClientId)) {
				if (!buddiesOnly) parts.push('You');
				latest.delete(myClientId);
			}
			const buddies = [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
			for (const record of buddies.slice(0, 2)) parts.push(YTB.buddyName(record.clientId, record.name, roster));
			const rest = buddies.length - Math.min(buddies.length, 2);
			if (rest > 0) parts.push(`and ${rest} other${rest === 1 ? '' : 's'}`);
			if (parts.length === 0) return '';
			if (parts.length === 1) return parts[0];
			if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
			// Three or more: Oxford-comma list; the collapsed tail already says "and".
			const last = parts[parts.length - 1];
			return parts.slice(0, -1).join(', ') + ', ' + (last.startsWith('and ') ? last : 'and ' + last);
		},

		// Watch Status (CONTEXT.md): nearest 5%, "Watched" at 80%+, floored at 5%;
		// null with no usable duration (never renders "NaN%").
		watchStatus(timestamp, duration) {
			const t = Number(timestamp);
			const d = Number(duration);
			if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return null;
			const rounded = Math.round((t / d) * 20) * 5;
			if (rounded >= 80) return 'Watched';
			return Math.max(rounded, 5) + '%';
		},

		// The Watched-By Dots tooltip's rows: one per Buddy with a Progress Record
		// (viewer excluded), newest first - same order the dots render in; the
		// Room cap bounds this at four rows.
		watchedByRows(progress, videoId, myClientId, roster) {
			const latest = new Map(); // clientId -> latest record for this video
			for (const r of progress || []) {
				if (!r || !r.clientId || r.videoId !== videoId || r.clientId === myClientId) continue;
				const prev = latest.get(r.clientId);
				if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.clientId, r);
			}
			return [...latest.values()]
				.sort((a, b) => b.updatedAt - a.updatedAt || (a.clientId < b.clientId ? -1 : 1))
				.map((r) => ({
					clientId: r.clientId,
					name: YTB.buddyName(r.clientId, r.name, roster),
					status: YTB.watchStatus(r.timestamp, r.duration),
				}));
		},

		// Accessible name for the Watched-By Dots cluster: flat equivalent of the
		// visual rows.
		watchedByAriaLabel(rows) {
			if (!rows || rows.length === 0) return '';
			return 'Watched by ' + rows.map((r) => (r.status ? `${r.name} ${r.status}` : r.name)).join(', ');
		},

		// "Recommended for you" (ADR-0007): items not added by the viewer, minus
		// Dismissed instances, newest first. Dismiss keys on the item's
		// server-minted id, so a re-recommend (new id) resurfaces a Dismissed video.
		recommendedForYou(playlist, myClientId, dismissedIds) {
			const dismissed = new Set(dismissedIds || []);
			return (playlist || [])
				.filter((item) => item && item.videoId && item.addedBy !== myClientId && !dismissed.has(item.id))
				.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
		},

		// Recommend Control state: the Room's authoritative `addedBy` with the
		// pending Recommend Intent overlaid (CONTEXT.md). A Buddy's addedBy
		// outranks a pending 'mine' (a no-op recommend settles to "Recommended to
		// you" as a correction, not a flicker).
		recommendPillState({ addedBy, myClientId, pending }) {
			const effective = pending === 'mine' ? (addedBy === undefined ? myClientId : addedBy) : pending === 'absent' ? undefined : addedBy;
			if (effective === undefined) return 'idle';
			return myClientId && effective === myClientId ? 'recommended' : 'added';
		},

		// Has a Room read caught up with the pending Recommend Intent? 'mine'
		// settles once ANY addedBy exists (mine, or the Buddy my no-op add hit);
		// 'absent' once addedBy is gone; no intent is vacuously settled.
		recommendIntentSettled({ addedBy, myClientId: _myClientId, pending }) {
			if (pending === 'mine') return addedBy !== undefined;
			if (pending === 'absent') return addedBy === undefined;
			return true;
		},

		// Dismissed Recommendations (ADR-0007): local, Room-scoped, keyed by item
		// id, never reaches the backend. Deliberately no un-dismiss yet.
		async dismissedIds(code) {
			return YTB._roomLists.read('dismissedRecommendations', code);
		},

		async dismissRecommendation(code, id) {
			if (!code || !id) return YTB.dismissedIds(code);
			return YTB._roomLists.update('dismissedRecommendations', code, (room) => (room.includes(id) ? room : [...room, id]));
		},

		// Prune Dismissals against a SUCCESSFUL Room read only; a failed read's
		// empty playlist would resurface every Dismissed card.
		async pruneDismissed(code, liveIds) {
			if (!code) return [];
			const live = new Set(liveIds || []);
			return YTB._roomLists.update('dismissedRecommendations', code, (room) => room.filter((id) => live.has(id)));
		},

		// Unseen set (ADR-0010): the Note ids whose dots pulse - each anchors an
		// Unseen Mention or Unseen Reply not yet seen, exactly what the Room Feed
		// emphasizes. A Reaction never pulses; a Reply with no parent is ignored.
		unseenNoteIds(records, myClientId, seenIds) {
			const seen = new Set(seenIds || []);
			const notes = (records && records.notes) || [];
			const replies = (records && records.replies) || [];
			const noteById = new Map(notes.filter((note) => note && note.id).map((note) => [note.id, note]));
			const out = new Set();
			for (const note of notes) {
				if (!note || note.kind === 'emoji' || seen.has(note.id)) continue;
				if (YTB.noteAddressesMe(note, myClientId)) out.add(note.id);
			}
			for (const reply of replies) {
				if (!reply || seen.has(reply.id)) continue;
				const parent = noteById.get(reply.noteId);
				if (!parent || parent.kind === 'emoji') continue;
				if (YTB.replyAddressesMe(reply, parent, myClientId)) out.add(parent.id);
			}
			return [...out];
		},

		// The exact ids Acknowledging one Note Dot clears: the Note itself (if it
		// Mentions the viewer) plus every addressed Reply beneath it. Idempotent.
		acknowledgeTargets(records, myClientId, noteId) {
			const notes = (records && records.notes) || [];
			const note = notes.find((candidate) => candidate && candidate.id === noteId);
			if (!note || note.kind === 'emoji') return [];
			const ids = [];
			if (YTB.noteAddressesMe(note, myClientId)) ids.push(note.id);
			for (const reply of (records && records.replies) || []) {
				if (reply && reply.id && reply.noteId === noteId && YTB.replyAddressesMe(reply, note, myClientId)) ids.push(reply.id);
			}
			return ids;
		},

		async seenIds(code) {
			return YTB._roomLists.read('seenItems', code);
		},

		// Acknowledge: persist ids into the Room's seen set so the dot never
		// pulses again, across reloads/sessions. Idempotent, local-only.
		async markSeen(code, ids) {
			const additions = [...(ids || [])].filter((id) => typeof id === 'string' && id !== '');
			if (!code || additions.length === 0) return YTB.seenIds(code);
			return YTB._roomLists.update('seenItems', code, (room) => {
				const merged = new Set(room);
				for (const id of additions) merged.add(id);
				return merged.size === room.length ? room : [...merged];
			});
		},

		// Prune seen ids against a SUCCESSFUL Room read only; a failed read's
		// empty arrays would resurrect every Acknowledged pulse.
		async pruneSeen(code, liveIds) {
			if (!code) return [];
			const live = new Set(liveIds || []);
			return YTB._roomLists.update('seenItems', code, (room) => room.filter((id) => live.has(id)));
		},

		// Local calendar day of an epoch-ms instant, e.g. "2026-07-05".
		_dayKey(ms) {
			const d = new Date(Number(ms) || 0);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		},

		// Feed day-divider label: "Today", "Yesterday", or a short date ("Jul 3").
		dayLabel(dayKey, nowMs = Date.now()) {
			if (dayKey === YTB._dayKey(nowMs)) return 'Today';
			if (dayKey === YTB._dayKey(nowMs - 24 * 3600_000)) return 'Yesterday';
			const [y, m, d] = String(dayKey)
				.split('-')
				.map((part) => Number(part));
			return new Date(y, m - 1, d).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
			});
		},

		// Whether a Note is addressed to the viewer: a FOREIGN Note whose mentions
		// include their Client ID (ADR-0006). The one rule buildFeed and
		// unseenNoteIds both consume, so they never drift.
		noteAddressesMe(note, myClientId) {
			if (!note || note.clientId === myClientId) return false;
			return Array.isArray(note.mentions) && note.mentions.includes(myClientId);
		},

		// Whether a Reply is addressed to the viewer: FOREIGN, and either under
		// the viewer's own Note or Mentioning them.
		replyAddressesMe(reply, parentNote, myClientId) {
			if (!reply || reply.clientId === myClientId) return false;
			if (parentNote && parentNote.clientId === myClientId) return true;
			return Array.isArray(reply.mentions) && reply.mentions.includes(myClientId);
		},

		// The Room Feed from one Room read (ADR-0007): EVERY text Note and Reply
		// in the Room (own included, `own`-flagged for "You" copy), with the
		// addressed-to-me items typed 'reply'/'mention' for emphasis (the shared
		// noteAddressesMe/replyAddressesMe rule, so Feed and Timeline never
		// drift) and the rest typed 'note'; Reactions never appear. Plus
		// recommend System Messages (with `removed` when superseded or
		// un-recommended) and Watch Notices (recommender-only, one per
		// Buddy+video). Sorted oldest -> newest, grouped under day dividers; no
		// read/unread state.
		buildFeed(records, myClientId) {
			const notes = (records && records.notes) || [];
			const replies = (records && records.replies) || [];
			const events = (records && records.events) || [];
			const playlist = (records && records.playlist) || [];
			const progress = (records && records.progress) || [];
			const noteById = new Map(notes.map((note) => [note.id, note]));

			const items = [];
			for (const reply of replies) {
				if (!reply) continue;
				const parent = noteById.get(reply.noteId) || null;
				if (parent && parent.kind === 'emoji') continue;
				const at = Number(reply.createdAt) || 0;
				if (YTB.replyAddressesMe(reply, parent, myClientId)) {
					const toMyNote = Boolean(parent) && parent.clientId === myClientId;
					items.push({ type: toMyNote ? 'reply' : 'mention', at, reply, note: parent });
				} else {
					items.push({ type: 'note', at, reply, note: parent, own: reply.clientId === myClientId });
				}
			}
			for (const note of notes) {
				if (!note || note.kind === 'emoji') continue;
				const at = Number(note.createdAt) || 0;
				if (YTB.noteAddressesMe(note, myClientId)) items.push({ type: 'mention', at, note });
				else items.push({ type: 'note', at, note, own: note.clientId === myClientId });
			}
			// Only `added` events count (un-recommends emit none). `removed`
			// (ADR-0007) is per-event: a newer `added` for the same videoId
			// supersedes it, and a dead videoId strikes it - so a re-recommend
			// revives only its own fresh line.
			const liveRecommendationIds = new Set();
			for (const item of playlist) {
				if (item && item.videoId) liveRecommendationIds.add(item.videoId);
			}
			const newestAddedAt = new Map(); // videoId -> max(at) among `added` Events
			for (const event of events) {
				if (!event || event.type !== 'added') continue;
				const at = Number(event.at) || 0;
				if (at > (newestAddedAt.get(event.videoId) ?? -Infinity)) newestAddedAt.set(event.videoId, at);
			}
			for (const event of events) {
				if (!event || event.type !== 'added') continue;
				const at = Number(event.at) || 0;
				items.push({
					type: 'system',
					at,
					event,
					own: event.actorClientId === myClientId,
					removed: at < newestAddedAt.get(event.videoId) || !liveRecommendationIds.has(event.videoId),
				});
			}
			// Watch Notices: one per Buddy with a Progress Record for a video the
			// viewer recommended; title from the Playlist Item, not the Progress Record.
			const myRecTitles = new Map();
			for (const item of playlist) {
				if (item && item.videoId && item.addedBy === myClientId) myRecTitles.set(item.videoId, item.title);
			}
			for (const record of progress) {
				if (!record || !record.clientId || record.clientId === myClientId) continue;
				if (!myRecTitles.has(record.videoId)) continue;
				items.push({
					type: 'watch',
					at: Number(record.updatedAt) || 0,
					videoId: record.videoId,
					title: myRecTitles.get(record.videoId),
					clientId: record.clientId,
					name: record.name,
				});
			}
			items.sort((a, b) => a.at - b.at);

			const groups = [];
			let current = null;
			for (const item of items) {
				const dayKey = YTB._dayKey(item.at);
				if (!current || current.dayKey !== dayKey) {
					current = { dayKey, items: [] };
					groups.push(current);
				}
				current.items.push(item);
			}
			return groups;
		},

		// Trim a day-grouped Feed to its newest `limit` items ("Show more");
		// item-level, so a partly revealed day keeps its divider with only its
		// newest tail and an empty day is dropped. Pure - never mutates the input.
		tailFeed(groups, limit) {
			const source = Array.isArray(groups) ? groups : [];
			const total = source.reduce((sum, group) => sum + (((group && group.items) || []).length || 0), 0);
			const keep = Math.max(0, Math.min(total, Math.floor(Number(limit) || 0)));
			const hidden = total - keep;
			const trimmed = [];
			let toSkip = hidden; // items are oldest -> newest, so hide from the front
			for (const group of source) {
				const items = (group && group.items) || [];
				if (toSkip >= items.length) {
					toSkip -= items.length; // whole day hidden - its divider renders nowhere
					continue;
				}
				trimmed.push({ dayKey: group.dayKey, items: items.slice(toSkip) });
				toSkip = 0;
			}
			return { groups: trimmed, hidden };
		},
	});
})();
