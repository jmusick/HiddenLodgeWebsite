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

  try {
    const formData = await context.request.formData();
    const name = (formData.get('name') as string | null)?.trim() ?? '';
    const url = (formData.get('url') as string | null)?.trim() ?? '';
    const sortOrder = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

    if (!name || !url || !isValidHttpUrl(url)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    await env.DB
      .prepare(`INSERT INTO raiding_addons (name, url, sort_order) VALUES (?, ?, ?)`)
      .bind(name, url, isNaN(sortOrder) ? 0 : sortOrder)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=addon-created' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
