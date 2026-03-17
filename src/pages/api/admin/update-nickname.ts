export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const userId = parseInt(formData.get('user_id') as string, 10);
	const nickname = (formData.get('nickname') as string | null)?.trim() || null;

	if (isNaN(userId)) {
		return new Response('Invalid user_id', { status: 400 });
	}

	// Verify the target user has at least one guild character (prevents arbitrary user editing)
	const isGuildUser = await env.DB.prepare(`
		SELECT 1 FROM characters c
		JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
		WHERE c.user_id = ?
		LIMIT 1
	`)
		.bind(userId)
		.first();

	if (!isGuildUser) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	await env.DB.prepare(
		`UPDATE users SET nickname = ?, updated_at = unixepoch() WHERE id = ?`
	)
		.bind(nickname, userId)
		.run();

	return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=ok' } });
}
