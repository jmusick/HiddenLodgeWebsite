export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const title = (formData.get('title') as string | null)?.trim() ?? '';
	const icon = (formData.get('icon') as string | null)?.trim() || 'lucide:link';
	const sort_order = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

	if (!title) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	await env.DB.prepare(
		`INSERT INTO link_categories (title, icon, sort_order) VALUES (?, ?, ?)`
	)
		.bind(title, icon, isNaN(sort_order) ? 0 : sort_order)
		.run();

	return new Response(null, { status: 302, headers: { Location: '/admin/links?status=cat-created' } });
}
