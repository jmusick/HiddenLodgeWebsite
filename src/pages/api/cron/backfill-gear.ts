import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { backfillRaiderGear } from '../../../lib/raiders';

export const prerender = false;

/**
 * One-shot gear backfill, kept separate from /api/cron/refresh so it can be
 * called repeatedly without re-running the roster/attendance/professions/
 * trinkets refreshes on every invocation.
 *
 * Call with ?limit=N (default 25, max 100) until the response reports
 * done: true. Safe to rerun — it only picks raiders with no cached gear.
 */
export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  try {
    const result = await backfillRaiderGear({ limit });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error('Gear backfill failed', error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
};
