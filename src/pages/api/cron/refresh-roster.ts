import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { refreshRosterCache } from '../../../lib/roster-cache';
import { refreshRaidersCache } from '../../../lib/raiders';

export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const [rosterStatus, raidersStatus] = await Promise.all([
      refreshRosterCache(),
      refreshRaidersCache(),
    ]);

    return Response.json({
      success: true,
      roster: rosterStatus,
      raiders: raidersStatus,
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
};
