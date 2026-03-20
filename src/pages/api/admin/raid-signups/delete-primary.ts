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
  const id = Number.parseInt((formData.get('id') as string | null) ?? '', 10);
  if (Number.isNaN(id) || id <= 0) return statusRedirect('error');

  await env.DB.prepare('DELETE FROM primary_raid_schedules WHERE id = ?').bind(id).run();
  return statusRedirect('primary-deleted');
}
