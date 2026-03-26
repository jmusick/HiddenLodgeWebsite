export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const VALID_STATUSES = new Set(['received', 'reviewed', 'contacted', 'rejected', 'trial']);

export async function POST(context: APIContext): Promise<Response> {
	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});

	if (!context.locals.isAdmin) return json({ error: 'Forbidden' }, 403);

	const id = Number(context.params.id);
	if (!id) return json({ error: 'Invalid application ID.' }, 400);

	let body: { status?: string };
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'Invalid request body.' }, 400);
	}

	const status = body.status ?? '';
	if (!VALID_STATUSES.has(status)) return json({ error: 'Invalid status value.' }, 400);

	await env.DB.prepare('UPDATE applications SET status = ? WHERE id = ?').bind(status, id).run();

	return json({ ok: true });
}
