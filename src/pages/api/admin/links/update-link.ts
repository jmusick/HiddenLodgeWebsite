export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const id = parseInt(formData.get('id') as string, 10);
	const name = (formData.get('name') as string | null)?.trim() ?? '';
	const href = (formData.get('href') as string | null)?.trim() ?? '';
	const sort_order = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

	if (isNaN(id) || !name || !href || !isValidHttpUrl(href)) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	const result = await env.DB.prepare(
		`UPDATE links SET name = ?, href = ?, sort_order = ?, updated_at = unixepoch() WHERE id = ?`
	)
		.bind(name, href, isNaN(sort_order) ? 0 : sort_order, id)
		.run();

	if (!result.success || result.meta.changes === 0) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	return new Response(null, { status: 302, headers: { Location: '/admin/links?status=link-updated' } });
}
