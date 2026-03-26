export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});

	if (!context.locals.isAdmin) return json({ error: 'Forbidden' }, 403);

	const id = Number(context.params.id);
	if (!id) return json({ error: 'Invalid application ID.' }, 400);

	let body: { noteId?: number };
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'Invalid request body.' }, 400);
	}

	const noteId = Number(body.noteId);
	if (!noteId) return json({ error: 'Invalid note ID.' }, 400);

	// Verify the note belongs to this application before deleting
	await env.DB.prepare(`DELETE FROM application_notes WHERE id = ? AND application_id = ?`)
		.bind(noteId, id)
		.run();

	return json({ ok: true });
}
