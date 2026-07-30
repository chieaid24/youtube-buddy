export interface Env {
	PROGRESS: KVNamespace;
}

export interface ProgressBody {
	clientId: string;
	name: string;
	videoId: string;
	timestamp: number;
	duration: number;
}

export interface PresenceBody {
	clientId: string;
	name: string;
}

export interface NoteBody {
	clientId: string;
	name: string;
	videoId: string;
	videoTitle?: string;
	timestamp: number;
	kind: 'text' | 'emoji';
	body: string;
	spoiler: boolean;
	mentions?: string[];
}

export interface ReplyBody {
	clientId: string;
	name: string;
	noteId: string;
	body: string;
	mentions?: string[];
}

export interface PlaylistBody {
	clientId: string;
	name: string;
	videoId: string;
	title: string;
}

// Stable machine-readable error categories. The extension branches on these —
// never on the prose in `error`.
export type ErrorCategory =
	'validation' | 'room_full' | 'reply_cap' | 'missing_parent' | 'forbidden' | 'not_allowed' | 'unexpected' | 'playlist_full';

export interface LogContext {
	op: string;
	requestId: string;
}
