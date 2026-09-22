export const prerender = false;

import type { APIContext } from 'astro';
import { refreshBenchParses } from '../../../../lib/bench';
import { refreshPullScores } from '../../../../lib/pull-scores';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

/** Manual budget: one Warcraft Logs request per 10 raiders, so a full refresh normally fits. */
const MANUAL_REFRESH_BUDGET_MS = 15_000;
/** Per-pull `table` queries are heavier WCL load, so Pull Scores get their own smaller budget. */
const MANUAL_PULL_SCORES_BUDGET_MS = 8_000;

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  let status = 'refresh-ok';
  try {
    const [parses, pullScores] = await Promise.all([
      refreshBenchParses(undefined, { force: true, budgetMs: MANUAL_REFRESH_BUDGET_MS }),
      refreshPullScores(undefined, { budgetMs: MANUAL_PULL_SCORES_BUDGET_MS }),
    ]);
    if (parses.rateLimited || pullScores.rateLimited) status = 'refresh-rate-limited';
    else if (parses.remaining > 0 || pullScores.remaining > 0) status = 'refresh-partial';
  } catch (error) {
    console.error('Bench refresh failed', error);
    status = 'refresh-error';
  }
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}
