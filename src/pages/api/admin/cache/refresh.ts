export const prerender = false;

import type { APIContext } from 'astro';
import { refreshRaidersCache } from '../../../../lib/raiders';
import { refreshRosterCache } from '../../../../lib/roster-cache';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const [rosterResult, raidersResult] = await Promise.allSettled([
    refreshRosterCache(),
    refreshRaidersCache(),
  ]);

  const failed: string[] = [];
  if (rosterResult.status === 'rejected') {
    console.error('Admin cache refresh: roster refresh failed', rosterResult.reason);
    failed.push('roster');
  }
  if (raidersResult.status === 'rejected') {
    console.error('Admin cache refresh: raiders refresh failed', raidersResult.reason);
    failed.push('raiders');
  }

  const status =
    failed.length === 0 ? 'refresh-ok' : failed.length === 1 ? 'refresh-partial' : 'refresh-error';

  const params = new URLSearchParams({ status });
  if (failed.length > 0) {
    params.set('failed', failed.join(','));
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/settings?${params.toString()}` },
  });
}