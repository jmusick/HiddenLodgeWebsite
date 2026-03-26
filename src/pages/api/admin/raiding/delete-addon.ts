export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const formData = await context.request.formData();
    const id = parseInt((formData.get('id') as string | null) ?? '', 10);

    if (isNaN(id)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    await env.DB.prepare(`DELETE FROM raiding_addons WHERE id = ?`).bind(id).run();

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=addon-deleted' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
