interface Env {
  PROGRESS: KVNamespace;
}

interface ProgressBody {
  name: string;
  videoId: string;
  timestamp: number;
}

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
      const body = (await req.json()) as ProgressBody;
      // expects { name, videoId, timestamp }
      const key = `${code}:${body.name}`;
      await env.PROGRESS.put(
        key,
        JSON.stringify({ ...body, updatedAt: Date.now() })
      );
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}