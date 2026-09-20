export const prerender = false;

import type { APIContext } from 'astro';
import { refreshBenchParses } from '../../../../lib/bench';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

/** Manual budget: one Warcraft Logs request per 10 raiders, so a full refresh normally fits. */
const MANUAL_REFRESH_BUDGET_MS = 15_000;

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  let status = 'refresh-ok';
  try {
    const result = await refreshBenchParses(undefined, { force: true, budgetMs: MANUAL_REFRESH_BUDGET_MS });
    if (result.rateLimited) status = 'refresh-rate-limited';
    else if (result.remaining > 0) status = 'refresh-partial';
  } catch (error) {
    console.error('Bench parse refresh failed', error);
    status = 'refresh-error';
  }
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}
