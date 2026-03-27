export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isValidTimeZone } from '../../../lib/time-zones';

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const formData = await context.request.formData();
  const timeZone = (formData.get('time_zone') as string | null)?.trim() ?? '';

  if (!isValidTimeZone(timeZone)) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/profile?status=timezone-error' },
    });
  }

  await env.DB.prepare('UPDATE users SET time_zone = ?, time_zone_set = 1, updated_at = unixepoch() WHERE id = ?')
    .bind(timeZone, user.id)
    .run();

  return new Response(null, {
    status: 302,
    headers: { Location: '/profile?status=timezone-updated' },
  });
}
