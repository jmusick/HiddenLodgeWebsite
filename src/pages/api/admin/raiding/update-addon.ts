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
    const id = parseInt((formData.get('id') as string | null) ?? '', 10);
    const name = (formData.get('name') as string | null)?.trim() ?? '';
    const url = (formData.get('url') as string | null)?.trim() ?? '';
    const sortOrder = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

    if (isNaN(id) || !name || !url || !isValidHttpUrl(url)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    const result = await env.DB
      .prepare(`UPDATE raiding_addons SET name = ?, url = ?, sort_order = ? WHERE id = ?`)
      .bind(name, url, isNaN(sortOrder) ? 0 : sortOrder, id)
      .run();

    if (!result.meta.changes) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=addon-updated' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
