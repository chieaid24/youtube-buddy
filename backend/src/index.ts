interface Env {
	PROGRESS: KVNamespace;
}

interface ProgressBody {
	clientId: string;
	name: string;
	videoId: string;
	timestamp: number;
	duration: number;
}

interface PresenceBody {
	clientId: string;
	name: string;
}

// Progress Records age out 14 days after their last write. Active videos keep
// getting rewritten so they never expire; abandoned ones drop, which also
// bounds the GET prefix scan. Presence Records share the same TTL.
const TTL_SECONDS = 14 * 24 * 3600;

// A Room Code is one Room of at most this many distinct Client IDs (you +
// up to 4 Buddies). Enforced best-effort on POST — see the cap check below.
const MAX_MEMBERS = 5;

const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		// Preflight, for any path.
		if (req.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const url = new URL(req.url);
		const code = url.searchParams.get('code');

		if (!code) {
			return json({ error: 'missing code' }, 400);
		}

		const prefix = `${code}:`;
		const path = url.pathname;

		// Presence: a member appears the instant they join a Code, independent of
		// whether they're watching anything. Stored under `${code}:presence:${id}`.
		if (req.method === 'POST' && path === '/presence') {
			const body = (await req.json()) as Partial<PresenceBody>;
			if (typeof body.clientId !== 'string' || body.clientId === '') {
				return json({ error: 'missing or invalid field: clientId' }, 400);
			}

			// A presence row reserves a Room slot just like a progress row — see the
			// cap-check note in currentMembers.
			const members = await currentMembers(env, prefix);
			if (!members.has(body.clientId) && members.size >= MAX_MEMBERS) {
				return json({ error: 'room full' }, 409);
			}

			// updatedAt is server-authoritative; name is optional (coerced to "").
			const record = {
				clientId: body.clientId,
				name: typeof body.name === 'string' ? body.name : '',
				updatedAt: Date.now(),
			};
			await env.PROGRESS.put(`${prefix}presence:${body.clientId}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
			return json({ ok: true });
		}

		// Leaving a Room removes the member completely: their presence row and all
		// Progress Records, across every page of the KV listing. Deleting absent
		// keys is harmless, so the operation is idempotent.
		if (req.method === 'DELETE' && path === '/member') {
			const clientId = url.searchParams.get('clientId');
			if (!clientId) {
				return json({ error: 'missing clientId' }, 400);
			}
			await deleteMember(env, prefix, clientId);
			return json({ ok: true });
		}

		if (req.method === 'POST' && path === '/') {
			const body = (await req.json()) as Partial<ProgressBody>;
			const error = validate(body);
			if (error) {
				return json({ error }, 400);
			}

			// Best-effort Room cap: a Room Code holds at most MAX_MEMBERS distinct
			// Client IDs, counting both progress and presence rows. A brand-new
			// Client ID is rejected once the Room is full; returning members — and
			// their new videos — always go through. See currentMembers.
			const members = await currentMembers(env, prefix);
			if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
				return json({ error: 'room full' }, 409);
			}

			// updatedAt is server-authoritative — never trust the client's value.
			const key = `${prefix}${body.clientId}:${body.videoId}`;
			const record = {
				clientId: body.clientId,
				name: body.name ?? '',
				videoId: body.videoId,
				timestamp: body.timestamp,
				duration: body.duration,
				updatedAt: Date.now(),
			};
			await env.PROGRESS.put(key, JSON.stringify(record), {
				expirationTtl: TTL_SECONDS,
			});
			return json({ ok: true });
		}

		if (req.method === 'GET' && path === '/') {
			// One prefix scan over both kinds; partition by key shape. Presence keys
			// carry the "presence" infix (`${code}:presence:${id}`); everything else
			// is a progress key (`${code}:${id}:${videoId}`).
			const list = await env.PROGRESS.list({ prefix });
			const progress: unknown[] = [];
			const presence: unknown[] = [];
			await Promise.all(
				list.keys.map(async (k) => {
					const value = await env.PROGRESS.get(k.name);
					if (value === null) return;
					const isPresence = k.name.slice(prefix.length).split(':')[0] === 'presence';
					(isPresence ? presence : progress).push(JSON.parse(value));
				}),
			);
			return json({ progress, presence });
		}

		return json({ error: 'method not allowed' }, 405);
	},
} satisfies ExportedHandler<Env>;

// Derives the Room's current distinct Client IDs from existing key names under
// the Code's prefix — no value reads. Both key kinds reserve a slot: progress
// keys are `${code}:${clientId}:${videoId}` (member id is the first segment)
// and presence keys are `${code}:presence:${clientId}` (member id is the second
// segment). The "presence" infix can never collide with a Client ID (8 hex
// chars). KV is eventually consistent with no transactions, so a
// simultaneous-join race (or a >1000-key code whose listing truncates) can
// momentarily admit a 6th member; acceptable for a friends-only weak-secret app.
async function currentMembers(env: Env, prefix: string): Promise<Set<string>> {
	const existing = await env.PROGRESS.list({ prefix });
	const members = new Set<string>();
	for (const k of existing.keys) {
		const parts = k.name.slice(prefix.length).split(':');
		members.add(parts[0] === 'presence' ? parts[1] : parts[0]);
	}
	return members;
}

async function deleteMember(env: Env, prefix: string, clientId: string): Promise<void> {
	const progressPrefix = `${prefix}${clientId}:`;
	let cursor: string | undefined;

	do {
		const page = await env.PROGRESS.list({
			prefix: progressPrefix,
			cursor,
			limit: 500,
		});
		await Promise.all(page.keys.map(({ name }) => env.PROGRESS.delete(name)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	await env.PROGRESS.delete(`${prefix}presence:${clientId}`);
}

// Returns an error message for an invalid POST body, or null if it is valid.
// `name` is intentionally NOT required: Display Name is optional (a blank name
// still shares; consumers render a stable "<Adjective> Buddy" fallback derived
// from clientId — see YTB.buddyName). Missing/empty name is coerced to "" on
// store.
function validate(body: Partial<ProgressBody>): string | null {
	for (const field of ['clientId', 'videoId'] as const) {
		if (typeof body[field] !== 'string' || body[field] === '') {
			return `missing or invalid field: ${field}`;
		}
	}
	for (const field of ['timestamp', 'duration'] as const) {
		if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
			return `missing or invalid field: ${field}`;
		}
	}
	return null;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}
