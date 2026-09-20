export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getRaidCompGroupCount, getRaidCompSettings, isTempRaidCompCandidate, RaidCompGroupFullError, setRaidCompAssignment } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

/** Drag-and-drop on the Raid Composition board: moves one raider into a group, or back to the bench (group: null). */
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
  const { blizzardCharId, group } = (body ?? {}) as { blizzardCharId?: unknown; group?: unknown };
  const charId = Number(blizzardCharId);
  if (!Number.isInteger(charId) || charId === 0) return new Response('Invalid blizzardCharId', { status: 400 });
  if (charId < 0 && !(await isTempRaidCompCandidate(env.DB, -charId))) return new Response('Unknown temporary candidate', { status: 404 });

  let groupValue: number | null = null;
  if (group !== null && group !== undefined) {
    const parsed = Number(group);
    const maxGroup = getRaidCompGroupCount(await getRaidCompSettings(env.DB));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxGroup) return new Response('Invalid group', { status: 400 });
    groupValue = parsed;
  }

  try {
    await setRaidCompAssignment(env.DB, charId, groupValue, context.locals.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof RaidCompGroupFullError) return new Response(error.message, { status: 409 });
    console.error('Raid Composition assignment update failed', error);
    return new Response('Failed to save', { status: 500 });
  }
}
