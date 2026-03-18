export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const id = parseInt(formData.get('id') as string, 10);

	if (isNaN(id)) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	await env.DB.prepare(`DELETE FROM links WHERE id = ?`).bind(id).run();

	return new Response(null, { status: 302, headers: { Location: '/admin/links?status=link-deleted' } });
}
