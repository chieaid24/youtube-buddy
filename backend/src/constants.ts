export const NOTE_EMOJIS = ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}'] as const;

// Progress Records age out 14 days after their last write. Active videos keep
// getting rewritten so they never expire; abandoned ones drop, which also
// bounds the GET prefix scan. Presence Records share the same TTL. A Note
// conversation (the parent Note plus its Replies) is refreshed as a unit on
// every new Reply, so no orphan Reply outlives its parent.
export const TTL_SECONDS = 14 * 24 * 3600;

// A Room Code is one Room of at most this many distinct Client IDs (you +
// up to 4 Buddies). Enforced best-effort on POST — see the cap check below.
export const MAX_MEMBERS = 5;

// A text Note (and each Reply) is a short message, not an essay.
export const NOTE_MAX_CHARS = 100;

// A Note conversation holds at most this many Replies. Best-effort under KV's
// eventual consistency: a concurrent race can momentarily admit an 11th; the
// client tolerates the rare overage.
export const MAX_REPLIES = 10;

// The Shared Playlist holds at most this many distinct videos per Room; a
// member must remove one before another fits. Best-effort like every other
// cap here (no KV transactions).
export const MAX_PLAYLIST_ITEMS = 30;

// Playlist Events (the log behind System Messages) keep only the newest ~50;
// older ones are pruned best-effort on each write. They also share TTL_SECONDS.
export const MAX_EVENTS = 50;

// Every caller-controlled value embedded in a colon-delimited KV key must be a
// single bounded segment. Client IDs also cannot equal a record-kind infix,
// because progress/member operations place them in the first segment.
export const KEY_SEGMENT_MAX_CHARS = 128;
export const RESERVED_KEY_KINDS = new Set(['presence', 'note', 'reply', 'playlist', 'event']);

// A video title is captured at write time — a Playlist Item's at add time, a
// Note's at post time. YouTube titles top out around 100 chars, so this bound
// only rejects abuse, never real titles.
export const TITLE_MAX_CHARS = 200;
