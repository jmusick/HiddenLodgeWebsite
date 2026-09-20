export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { clearRaidComp } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

/** Empties the shared board — every raider returns to the bench. Settings and saved loadouts are untouched. */
export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis || !FEATURE_FLAGS.raidComp) return new Response('Not found', { status: 404 });

  try {
    await clearRaidComp(env.DB);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Raid Comp clear failed', error);
    return new Response('Failed to clear', { status: 500 });
  }
}
