export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { purgeAllSimHistory } from '../../../../lib/sim-api';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const deleted = await purgeAllSimHistory(env.DB);

    const params = new URLSearchParams({ status: 'sim-purge-ok' });
    params.set('sim_runs_deleted', String(deleted.deleted_runs));
    params.set('sim_raider_summaries_deleted', String(deleted.deleted_raider_summaries));
    params.set('sim_item_winners_deleted', String(deleted.deleted_item_winners));
    params.set(
      'sim_legacy_raider_summaries_deleted',
      String(deleted.deleted_legacy_raider_summaries)
    );
    params.set('sim_legacy_item_winners_deleted', String(deleted.deleted_legacy_item_winners));

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/settings?${params.toString()}` },
    });
  } catch (error) {
    console.error('Admin sim purge failed', error);
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/settings?status=sim-purge-error' },
    });
  }
}
