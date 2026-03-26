export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const ALLOWED_KEYS = new Set(['schedule', 'raid_expectations', 'recruitment']);

/** Strip <script> tags and inline event handlers from admin-submitted rich HTML. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const formData = await context.request.formData();
    const key = (formData.get('key') as string | null)?.trim() ?? '';
    const rawContent = (formData.get('content') as string | null) ?? '';

    if (!ALLOWED_KEYS.has(key)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    const content = sanitizeHtml(rawContent.trim());

    await env.DB
      .prepare(
        `INSERT INTO raiding_content (key, content, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           content    = excluded.content,
           updated_at = excluded.updated_at`
      )
      .bind(key, content)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/raiding?status=${key}-updated` },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
