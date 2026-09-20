export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteRaidCompLoadout, loadRaidCompLoadout, renameRaidCompLoadout, saveRaidCompLoadout } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis || !FEATURE_FLAGS.raidComp) return new Response('Not found', { status: 404 });

  const formData = await context.request.formData();
  const action = String(formData.get('action') ?? '');
  try {
    if (action === 'save') {
      await saveRaidCompLoadout(env.DB, String(formData.get('name') ?? ''), context.locals.user.id);
      return redirect('loadout-saved');
    }
    const loadoutId = Number(formData.get('loadout_id'));
    if (!Number.isInteger(loadoutId) || loadoutId <= 0) return redirect('loadout-error');
    if (action === 'load') {
      await loadRaidCompLoadout(env.DB, loadoutId, context.locals.user.id);
      return redirect('loadout-loaded');
    }
    if (action === 'delete') {
      await deleteRaidCompLoadout(env.DB, loadoutId);
      return redirect('loadout-deleted');
    }
    if (action === 'rename') {
      await renameRaidCompLoadout(env.DB, loadoutId, String(formData.get('name') ?? ''), context.locals.user.id);
      return redirect('loadout-renamed');
    }
    return redirect('loadout-error');
  } catch (error) {
    console.error('Raid Composition loadout action failed', error);
    return redirect('loadout-error');
  }
}
