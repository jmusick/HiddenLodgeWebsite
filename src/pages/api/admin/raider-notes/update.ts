export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const id = parseInt(formData.get('id') as string, 10);
	const noteText = (formData.get('note_text') as string | null)?.trim() ?? '';

	if (isNaN(id) || !noteText) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	await env.DB.prepare(`UPDATE raider_notes SET note_text = ? WHERE id = ?`)
		.bind(noteText, id)
		.run();

	return new Response(null, {
		status: 302,
		headers: { Location: '/admin/mains?status=note-updated' },
	});
}
