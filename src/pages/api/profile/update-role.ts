export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

const VALID_ROLES = new Set(['tank', 'healer', 'melee-dps', 'ranged-dps']);

export async function POST(context: APIContext): Promise<Response> {
	if (!FEATURE_FLAGS.raidSignups) {
		return new Response('Not found', { status: 404 });
	}

	const user = context.locals.user;
	if (!user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await context.request.formData();
	const role = (formData.get('preferred_role') as string | null)?.trim() || null;

	if (role !== null && !VALID_ROLES.has(role)) {
		return new Response(null, {
			status: 302,
			headers: { Location: '/profile?status=role-error' },
		});
	}

	await env.DB.prepare('UPDATE users SET preferred_role = ?, updated_at = unixepoch() WHERE id = ?')
		.bind(role, user.id)
		.run();

	return new Response(null, {
		status: 302,
		headers: { Location: '/profile?status=role-updated' },
	});
}
