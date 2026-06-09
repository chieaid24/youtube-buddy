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

      // updatedAt is server-authoritative — never trust the client's value.
      const key = `${code}:${body.clientId}:${body.videoId}`;
      const record = {
        clientId: body.clientId,
        name: body.name,
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
function validate(body: Partial<ProgressBody>): string | null {
  for (const field of ["clientId", "name", "videoId"] as const) {
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
