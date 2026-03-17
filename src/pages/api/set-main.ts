export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	const user = context.locals.user;
	if (!user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await context.request.formData();
	const characterId = parseInt(formData.get('character_id') as string, 10);

	if (isNaN(characterId)) {
		return new Response('Invalid character_id', { status: 400 });
	}

	// Confirm the character belongs to the requesting user before touching any data
	const owns = await env.DB.prepare('SELECT id FROM characters WHERE id = ? AND user_id = ?')
		.bind(characterId, user.id)
		.first();

	if (!owns) {
		return new Response('Character not found', { status: 404 });
	}

	// Clear existing main, then set the new one — atomically
	await env.DB.batch([
		env.DB.prepare('UPDATE characters SET is_main = 0 WHERE user_id = ?').bind(user.id),
		env.DB.prepare('UPDATE characters SET is_main = 1 WHERE id = ? AND user_id = ?').bind(
			characterId,
			user.id
		),
	]);

	return new Response(null, { status: 302, headers: { Location: '/profile' } });
}
