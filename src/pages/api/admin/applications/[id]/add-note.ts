export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getSessionUser } from '../../../../../lib/auth';

export async function POST(context: APIContext): Promise<Response> {
	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});

	if (!context.locals.isAdmin) return json({ error: 'Forbidden' }, 403);

	const user = await getSessionUser(env.DB, context.request);
	if (!user) return json({ error: 'Forbidden' }, 403);

	const id = Number(context.params.id);
	if (!id) return json({ error: 'Invalid application ID.' }, 400);

	let body: { note?: string };
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'Invalid request body.' }, 400);
	}

	const note = (body.note ?? '').trim();
	if (!note) return json({ error: 'Note cannot be empty.' }, 400);

	const result = await env.DB.prepare(
		`INSERT INTO application_notes (application_id, author, note) VALUES (?, ?, ?)`
	)
		.bind(id, user.battleTag, note)
		.run();

	return json({ ok: true, id: result.meta.last_row_id, author: user.battleTag });
}
