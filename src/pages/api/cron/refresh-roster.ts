import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getRosterRefreshOptions, refreshRosterCache } from '../../../lib/roster-cache';
import { refreshRaidersCache } from '../../../lib/raiders';

export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const rosterOptions = getRosterRefreshOptions({
    batchSize: url.searchParams.get('detailBatchSize') ? Number.parseInt(url.searchParams.get('detailBatchSize')!, 10) : undefined,
    questBackfillBatchSize: url.searchParams.get('backfillBatchSize') ? Number.parseInt(url.searchParams.get('backfillBatchSize')!, 10) : undefined,
  });

  const [rosterResult, raidersResult] = await Promise.allSettled([
    refreshRosterCache(undefined, rosterOptions),
    refreshRaidersCache(),
  ]);

  const failures: string[] = [];
  if (rosterResult.status === 'rejected') {
    console.error('Cron roster refresh failed', rosterResult.reason);
    failures.push('roster');
  }
  if (raidersResult.status === 'rejected') {
    console.error('Cron raiders refresh failed', raidersResult.reason);
    failures.push('raiders');
  }

  return Response.json({
    success: failures.length === 0,
    partial: failures.length > 0,
    failed: failures,
    roster: rosterResult.status === 'fulfilled' ? rosterResult.value : null,
    raiders: raidersResult.status === 'fulfilled' ? raidersResult.value : null,
    requestedRosterOptions: rosterOptions,
  });
};
