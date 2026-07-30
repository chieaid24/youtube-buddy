import type { ErrorCategory, LogContext } from './types';

export const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

// Log-and-respond for every expected failure. The structured line carries the
// route/op, category, status, request id, and only OPAQUE identifiers (server-
// generated UUIDs) — never Room Codes, Client IDs, Display Names, or text.
// Expected client failures log at info; 5xx logs at error (see fetch).
export function fail(log: LogContext, status: number, category: ErrorCategory, error: string, ids?: Record<string, string>): Response {
	const line = JSON.stringify({ op: log.op, category, status, requestId: log.requestId, ...ids });
	if (status >= 500) console.error(line);
	else console.log(line);
	return json({ error, category }, status);
}

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}
