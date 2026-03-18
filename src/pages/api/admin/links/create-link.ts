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
	const category_id = parseInt(formData.get('category_id') as string, 10);
	const name = (formData.get('name') as string | null)?.trim() ?? '';
	const href = (formData.get('href') as string | null)?.trim() ?? '';
	const sort_order = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

	if (isNaN(category_id) || !name || !href || !isValidHttpUrl(href)) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	// Verify the category exists
	const cat = await env.DB.prepare(`SELECT 1 FROM link_categories WHERE id = ?`).bind(category_id).first();
	if (!cat) {
		return new Response(null, { status: 302, headers: { Location: '/admin/links?status=error' } });
	}

	await env.DB.prepare(
		`INSERT INTO links (category_id, name, href, sort_order) VALUES (?, ?, ?, ?)`
	)
		.bind(category_id, name, href, isNaN(sort_order) ? 0 : sort_order)
		.run();

	return new Response(null, { status: 302, headers: { Location: '/admin/links?status=link-created' } });
}
