export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { setUtilityMinimum } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

/** Officer sets how many providers of a utility item (e.g. Demonic Gateway) Regenerate should try to guarantee. */
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
  const { utility, minimum } = (body ?? {}) as { utility?: unknown; minimum?: unknown };
  const utilityName = String(utility ?? '').trim();
  if (!utilityName) return new Response('Invalid utility', { status: 400 });
  const minimumCount = Number(minimum);
  if (!Number.isFinite(minimumCount) || minimumCount < 0) return new Response('Invalid minimum', { status: 400 });

  try {
    await setUtilityMinimum(env.DB, utilityName, minimumCount, context.locals.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Raid Composition utility minimum update failed', error);
    return new Response('Failed to save', { status: 500 });
  }
}
