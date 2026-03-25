import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getRosterRefreshOptions, refreshRosterCache } from '../../../lib/roster-cache';
import { refreshRaidersCache } from '../../../lib/raiders';

export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const rosterOptions = getRosterRefreshOptions({
      batchSize: url.searchParams.get('detailBatchSize') ? Number.parseInt(url.searchParams.get('detailBatchSize')!, 10) : undefined,
      questBackfillBatchSize: url.searchParams.get('backfillBatchSize') ? Number.parseInt(url.searchParams.get('backfillBatchSize')!, 10) : undefined,
    });
    const [rosterStatus, raidersStatus] = await Promise.all([
      refreshRosterCache(undefined, rosterOptions),
      refreshRaidersCache(),
    ]);

    return Response.json({
      success: true,
      roster: rosterStatus,
      raiders: raidersStatus,
      requestedRosterOptions: rosterOptions,
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
};
