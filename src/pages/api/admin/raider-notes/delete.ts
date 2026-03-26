export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const NOTE_DELETE_BATTLE_TAG = 'Xing#1673';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	if (context.locals.user?.battleTag !== NOTE_DELETE_BATTLE_TAG) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const id = parseInt(formData.get('id') as string, 10);

	if (isNaN(id)) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	await env.DB.prepare(`DELETE FROM raider_notes WHERE id = ?`).bind(id).run();

	return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=note-deleted' } });
}
