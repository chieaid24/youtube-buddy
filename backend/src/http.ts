import type { ErrorCategory, LogContext } from './types';

export const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

// Log-and-respond for every expected failure: structured line carries op/category/status/requestId and only
// opaque UUIDs, never Room Codes/Client IDs/names/text. Client failures log at info, 5xx at error (see fetch).
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
