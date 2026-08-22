import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { refreshRaidersCache } from '../../../lib/raiders';

export const prerender = false;

/**
 * Raiders-only refresh.
 *
 * refreshRaidersCache() is by far the slowest leg of /api/cron/refresh, so
 * running it here gives it the scheduler's full per-request timeout instead of
 * sharing one with the roster/attendance/professions/trinkets refreshes.
 *
 * Pair this with /api/cron/refresh?skipRaiders=1 so the work is not done twice.
 */
export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const batchSizeParam = url.searchParams.get('detailBatchSize');
  const batchSize = batchSizeParam ? Number.parseInt(batchSizeParam, 10) : undefined;

  const startedAt = Date.now();
  try {
    const status = await refreshRaidersCache(undefined, { batchSize });
    return Response.json({ success: true, tookMs: Date.now() - startedAt, raiders: status });
  } catch (error) {
    console.error('Cron raiders refresh failed', error);
    return Response.json(
      {
        success: false,
        tookMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
};
