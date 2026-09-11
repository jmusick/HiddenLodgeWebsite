export const prerender = false;

import type { APIContext } from 'astro';
import { refreshDeathAnalysis } from '../../../../lib/death-analysis';
import { refreshMechanicsAnalysis } from '../../../../lib/mechanics-analysis';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  let status = 'sync-ok';
  try {
    const result = await refreshDeathAnalysis();
    const mechanics = FEATURE_FLAGS.mechanicsAnalysis && !result.rateLimited ? await refreshMechanicsAnalysis() : null;
    if (result.rateLimited || mechanics?.rateLimited) status = 'sync-rate-limited';
    else if (result.remaining > 0 || (mechanics?.remaining ?? 0) > 0) status = 'sync-partial';
  } catch (error) {
    console.error('Death analysis refresh failed', error);
    status = 'sync-error';
  }
  return new Response(null, { status: 302, headers: { Location: `/admin/log-matching?status=${status}` } });
}
