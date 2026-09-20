export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isTempRaidCompCandidate, swapRaidCompAssignments } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

/** Exchanges two raiders' group/bench placements from the shared Raid Composition board. */
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
  const { firstCharId, secondCharId } = (body ?? {}) as { firstCharId?: unknown; secondCharId?: unknown };
  const first = Number(firstCharId);
  const second = Number(secondCharId);
  if (!Number.isInteger(first) || !Number.isInteger(second) || first === 0 || second === 0 || first === second) {
    return new Response('Invalid raider IDs', { status: 400 });
  }
  for (const charId of [first, second]) {
    if (charId < 0 && !(await isTempRaidCompCandidate(env.DB, -charId))) {
      return new Response('Unknown temporary candidate', { status: 404 });
    }
  }

  try {
    await swapRaidCompAssignments(env.DB, first, second, context.locals.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Raid Composition swap failed', error);
    return new Response('Failed to swap', { status: 500 });
  }
}
