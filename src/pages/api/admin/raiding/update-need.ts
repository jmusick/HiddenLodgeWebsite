export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const VALID_PRIORITIES = new Set(['low', 'mid', 'high']);

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const formData = await context.request.formData();
    const id = parseInt((formData.get('id') as string | null) ?? '', 10);
    const priority = (formData.get('priority') as string | null)?.trim() ?? '';

    if (isNaN(id) || !VALID_PRIORITIES.has(priority)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    const result = await env.DB
      .prepare(`UPDATE recruitment_needs SET priority = ? WHERE id = ?`)
      .bind(priority, id)
      .run();

    if (!result.meta.changes) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=need-updated' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
