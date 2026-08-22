export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const characterId = parseInt(formData.get('character_id') as string, 10);

	if (isNaN(characterId)) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	// The character must exist, be claimed by a user, and that user must have at
	// least one character on the guild roster (same guard as update-nickname).
	const target = await env.DB.prepare(`
		SELECT c.id, c.user_id
		FROM characters c
		WHERE c.id = ?
		  AND c.user_id IS NOT NULL
		  AND EXISTS (
		    SELECT 1 FROM characters ci
		    JOIN roster_members_cache rmc ON rmc.blizzard_char_id = ci.blizzard_char_id
		    WHERE ci.user_id = c.user_id
		  )
	`)
		.bind(characterId)
		.first<{ id: number; user_id: number }>();

	if (!target) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	// Clear the existing main, then set the new one — atomically
	await env.DB.batch([
		env.DB.prepare('UPDATE characters SET is_main = 0 WHERE user_id = ?').bind(target.user_id),
		env.DB.prepare('UPDATE characters SET is_main = 1 WHERE id = ? AND user_id = ?').bind(
			target.id,
			target.user_id
		),
	]);

	return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=main-updated' } });
}
