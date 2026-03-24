export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	const user = context.locals.user;
	if (!user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await context.request.formData();
	const nickname = (formData.get('nickname') as string | null)?.trim() || null;

	if (nickname !== null && nickname.length > 48) {
		return new Response(null, {
			status: 302,
			headers: { Location: '/profile?status=nickname-error' },
		});
	}

	await env.DB.prepare('UPDATE users SET nickname = ?, updated_at = unixepoch() WHERE id = ?')
		.bind(nickname, user.id)
		.run();

	return new Response(null, {
		status: 302,
		headers: { Location: '/profile?status=nickname-updated' },
	});
}
