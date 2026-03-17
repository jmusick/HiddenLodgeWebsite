import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { refreshRosterCache } from '../../../lib/roster-cache';

export const POST: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const status = await refreshRosterCache();
    return Response.json({ success: true, ...status });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
};
