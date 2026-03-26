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

	// Only Xing#1673 can delete applications
	const user = await getSessionUser(env.DB, context.request);
	if (!user || user.battleTag !== 'Xing#1673') {
		return json({ error: 'Forbidden' }, 403);
	}

	const id = Number(context.params.id);
	if (!id) return json({ error: 'Invalid application ID.' }, 400);

	try {
		// Delete all notes for this application first (cascade)
		await env.DB.prepare('DELETE FROM application_notes WHERE application_id = ?').bind(id).run();

		// Delete all characters for this application
		await env.DB.prepare('DELETE FROM application_characters WHERE application_id = ?').bind(id).run();

		// Delete the application
		const result = await env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(id).run();

		if (!result.meta.changes) {
			return json({ error: 'Application not found.' }, 404);
		}

		return json({ ok: true });
	} catch (err) {
		console.error('delete application error:', err);
		return json({ error: 'An unexpected error occurred.' }, 500);
	}
}
