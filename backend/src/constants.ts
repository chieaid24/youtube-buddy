export const NOTE_EMOJIS = ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}'] as const;

// Records age out 14 days after their last write (bounding the GET prefix scan); a Note conversation is
// refreshed as a unit on every new Reply so no orphan Reply outlives its parent.
export const TTL_SECONDS = 14 * 24 * 3600;

// A Room holds at most this many distinct Client IDs (you + up to 4 Buddies); enforced best-effort on POST.
export const MAX_MEMBERS = 5;

// A text Note (and each Reply) is a short message, not an essay.
export const NOTE_MAX_CHARS = 100;

// Max Replies per Note conversation; best-effort under KV's eventual consistency, so a race can momentarily
// admit an 11th (client tolerates the rare overage).
export const MAX_REPLIES = 10;

// Max distinct videos per Room in the Shared Playlist; a member must remove one before another fits
// (best-effort, no KV transactions).
export const MAX_PLAYLIST_ITEMS = 30;

// Playlist Events (the log behind System Messages) keep only the newest ~50, pruned best-effort on each write;
// they share TTL_SECONDS.
export const MAX_EVENTS = 50;

// Every caller-controlled value in a colon-delimited KV key must be one bounded segment; Client IDs also can't
// equal a record-kind infix, since progress/member ops place them in the first segment.
export const KEY_SEGMENT_MAX_CHARS = 128;
export const RESERVED_KEY_KINDS = new Set(['presence', 'note', 'reply', 'playlist', 'event']);

// Video title captured at write time (Playlist Item at add, Note at post); YouTube titles top out ~100 chars,
// so this only rejects abuse.
export const TITLE_MAX_CHARS = 200;
