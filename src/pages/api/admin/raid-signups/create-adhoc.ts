export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const REDIRECT_BASE = '/admin/raid-signups';

function statusRedirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${REDIRECT_BASE}?status=${status}` } });
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const startsAtUtc = Number.parseInt((formData.get('starts_at_utc') as string | null) ?? '', 10);
  const notes = (formData.get('notes') as string | null)?.trim() || null;

  if (!name || name.length > 80 || Number.isNaN(startsAtUtc) || startsAtUtc <= 0) {
    return statusRedirect('error');
  }

  await env.DB.prepare(
    `INSERT INTO ad_hoc_raids
      (name, starts_at_utc, notes, is_active, updated_at)
     VALUES (?, ?, ?, 1, unixepoch())`
  )
    .bind(name, startsAtUtc, notes)
    .run();

  return statusRedirect('adhoc-created');
}
