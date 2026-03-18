export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const id = parseInt(formData.get('id') as string, 10);
	const title = (formData.get('title') as string | null)?.trim() ?? '';
	const icon = (formData.get('icon') as string | null)?.trim() || 'lucide:link';
	const sort_order = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

	if (isNaN(id) || !title) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	const result = await env.DB.prepare(
		`UPDATE link_categories SET title = ?, icon = ?, sort_order = ?, updated_at = unixepoch() WHERE id = ?`
	)
		.bind(title, icon, isNaN(sort_order) ? 0 : sort_order, id)
		.run();

	if (!result.success || result.meta.changes === 0) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	return new Response(null, { status: 302, headers: { Location: '/admin/links?status=cat-updated' } });
}
