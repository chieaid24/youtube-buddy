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

// Progress Records age out 14 days after their last write. Active videos keep
// getting rewritten so they never expire; abandoned ones drop, which also
// bounds the GET prefix scan.
const TTL_SECONDS = 14 * 24 * 3600;

// A Friend Code is one Group of at most this many distinct Client IDs (you +
// up to 4 Buddies). Enforced best-effort on POST — see the cap check below.
const MAX_MEMBERS = 5;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return json({ error: "missing code" }, 400);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Partial<ProgressBody>;
      const error = validate(body);
      if (error) {
        return json({ error }, 400);
      }

      // Best-effort Group cap: a Friend Code holds at most MAX_MEMBERS distinct
      // Client IDs. The current members are derived from existing key names
      // (`${code}:${clientId}:${videoId}`) with no value reads, and a brand-new
      // Client ID is rejected once the Group is full. Returning members — and
      // their new videos — always go through. KV is eventually consistent with
      // no transactions, so a simultaneous-join race (or a >1000-key code whose
      // listing truncates) can momentarily admit a 6th; acceptable for a
      // friends-only weak-secret app.
      const prefix = `${code}:`;
      const existing = await env.PROGRESS.list({ prefix });
      const members = new Set(
        existing.keys.map((k) => k.name.slice(prefix.length).split(":")[0])
      );
      if (!members.has(body.clientId!) && members.size >= MAX_MEMBERS) {
        return json({ error: "group full" }, 409);
      }

      // updatedAt is server-authoritative — never trust the client's value.
      const key = `${prefix}${body.clientId}:${body.videoId}`;
      const record = {
        clientId: body.clientId,
        name: body.name ?? "",
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

    if (req.method === "GET") {
      const list = await env.PROGRESS.list({ prefix: `${code}:` });
      const entries = await Promise.all(
        list.keys.map(async (k) => {
          const value = await env.PROGRESS.get(k.name);
          return value ? JSON.parse(value) : null;
        })
      );
      return json(entries.filter((e) => e !== null));
    }

    return json({ error: "method not allowed" }, 405);
  },
} satisfies ExportedHandler<Env>;

// Returns an error message for an invalid POST body, or null if it is valid.
// `name` is intentionally NOT required: Display Name is optional (a blank name
// still shares; consumers render a stable "<Adjective> Buddy" fallback derived
// from clientId — see YTB.buddyName). Missing/empty name is coerced to "" on
// store.
function validate(body: Partial<ProgressBody>): string | null {
  for (const field of ["clientId", "videoId"] as const) {
    if (typeof body[field] !== "string" || body[field] === "") {
      return `missing or invalid field: ${field}`;
    }
  }
  for (const field of ["timestamp", "duration"] as const) {
    if (typeof body[field] !== "number" || !Number.isFinite(body[field])) {
      return `missing or invalid field: ${field}`;
    }
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
