import { KEY_SEGMENT_MAX_CHARS, MAX_MEMBERS, NOTE_EMOJIS, NOTE_MAX_CHARS, RESERVED_KEY_KINDS, TITLE_MAX_CHARS } from './constants';
import type { NoteBody, PlaylistBody, ProgressBody, ReplyBody } from './types';

// Returns an error message for an invalid POST body, or null if it is valid.
// `name` is intentionally NOT required: Display Name is optional (a blank name
// still shares; consumers render a stable "<Adjective> Buddy" fallback derived
// from clientId — see YTB.buddyName). Missing/empty name is coerced to "" on
// store.
export function validate(body: Partial<ProgressBody>): string | null {
	if (!isValidClientId(body.clientId)) return 'missing or invalid field: clientId';
	if (!isValidKeySegment(body.videoId)) return 'missing or invalid field: videoId';
	for (const field of ['timestamp', 'duration'] as const) {
		if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
			return `missing or invalid field: ${field}`;
		}
	}
	return null;
}

export function validateNote(body: Partial<NoteBody>): string | null {
	if (!isValidClientId(body.clientId)) return 'missing or invalid field: clientId';
	if (!isValidKeySegment(body.videoId)) return 'missing or invalid field: videoId';
	// Checked through a local: iterating over field names cannot narrow
	// `body.body` for the length and emoji tests below.
	const text = body.body;
	if (typeof text !== 'string' || text === '') {
		return 'missing or invalid field: body';
	}
	if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
		return 'missing or invalid field: timestamp';
	}
	if (body.kind !== 'text' && body.kind !== 'emoji') {
		return 'missing or invalid field: kind';
	}
	if (body.kind === 'text' && text.length > NOTE_MAX_CHARS) {
		return `text body exceeds ${NOTE_MAX_CHARS} characters`;
	}
	if (body.kind === 'emoji' && !(NOTE_EMOJIS as readonly string[]).includes(text)) {
		return 'invalid emoji body';
	}
	if (body.spoiler !== undefined && typeof body.spoiler !== 'boolean') {
		return 'missing or invalid field: spoiler';
	}
	// A Reaction is never a Spoiler — reject the contradiction instead of
	// silently persisting it.
	if (body.kind === 'emoji' && body.spoiler === true) {
		return 'a reaction cannot be a spoiler';
	}
	return validateMentions(body.mentions);
}

export function validateReply(body: Partial<ReplyBody>): string | null {
	if (!isValidClientId(body.clientId)) return 'missing or invalid field: clientId';
	if (!isValidKeySegment(body.noteId)) return 'missing or invalid field: noteId';
	const text = body.body;
	if (typeof text !== 'string' || text === '') {
		return 'missing or invalid field: body';
	}
	if (text.length > NOTE_MAX_CHARS) {
		return `reply body exceeds ${NOTE_MAX_CHARS} characters`;
	}
	return validateMentions(body.mentions);
}

// Mentions are OPTIONAL (absent = none, keeping older clients and stored
// records valid). When present: an array of nonempty Client ID strings,
// bounded by the Room cap — a Note can never mention more people than a Room
// holds (ADR-0006).
export function validateMentions(mentions: unknown): string | null {
	if (mentions === undefined) return null;
	if (!Array.isArray(mentions) || mentions.length > MAX_MEMBERS || mentions.some((m) => !isValidClientId(m))) {
		return 'missing or invalid field: mentions';
	}
	return null;
}

export function isValidKeySegment(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && value.length <= KEY_SEGMENT_MAX_CHARS && !value.includes(':');
}

export function isValidClientId(value: unknown): value is string {
	return isValidKeySegment(value) && !RESERVED_KEY_KINDS.has(value);
}

// A Note's `videoTitle` is OPTIONAL context, never a reason to lose a Note: a
// missing, blank, non-string, or over-long title is dropped rather than
// rejected, so validateNote never sees it. Absent means "no title", and the
// Room Feed then shows no context fragment at all — never a placeholder.
// A Playlist Item's title, by contrast, IS the item, so validatePlaylist
// rejects a bad one.
export function sanitizeVideoTitle(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const title = value.trim();
	if (title === '' || title.length > TITLE_MAX_CHARS) return undefined;
	return title;
}

export function validatePlaylist(body: Partial<PlaylistBody>): string | null {
	if (!isValidClientId(body.clientId)) return 'missing or invalid field: clientId';
	if (!isValidKeySegment(body.videoId)) return 'missing or invalid field: videoId';
	if (typeof body.title !== 'string' || body.title === '') return 'missing or invalid field: title';
	if (body.title!.length > TITLE_MAX_CHARS) {
		return `title exceeds ${TITLE_MAX_CHARS} characters`;
	}
	return null;
}
