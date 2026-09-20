export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { setBuffMinimum } from '../../../lib/raid-comp';
import { CONFIGURABLE_RAID_BUFFS } from '../../../lib/raid-teams';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

/** Officer sets how many targets of a per-target raid buff (e.g. Hunter's Mark) Regenerate should try to guarantee. */
export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis || !FEATURE_FLAGS.raidComp) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const { buff, minimum } = (body ?? {}) as { buff?: unknown; minimum?: unknown };
  const buffName = String(buff ?? '').trim();
  if (!CONFIGURABLE_RAID_BUFFS.includes(buffName)) return new Response('Invalid buff', { status: 400 });
  const minimumCount = Number(minimum);
  if (!Number.isFinite(minimumCount) || minimumCount < 0) return new Response('Invalid minimum', { status: 400 });

  try {
    await setBuffMinimum(env.DB, buffName, minimumCount, context.locals.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Raid Composition buff minimum update failed', error);
    return new Response('Failed to save', { status: 500 });
  }
}
