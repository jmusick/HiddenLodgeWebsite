export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { regenerateRaidComp, type RaidCompScale } from '../../../lib/raid-comp';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

const MIN = 0;
const MAX = 40;

function clampInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN && n <= MAX ? n : fallback;
}

/** Saves the settings from the officer panel, then rebuilds and persists the whole board from Bench's current priority order. */
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
  const input = (body ?? {}) as Record<string, unknown>;
  const scale: RaidCompScale = input.scale === 'raw' ? 'raw' : 'percentile';
  const parseWeight = Number(input.parseWeight);
  const deathWeight = Number(input.deathWeight);
  const vaultWeight = Number(input.vaultWeight);
  const preparednessWeight = Number(input.preparednessWeight);
  const upgradesWeight = Number(input.upgradesWeight);
  const weights = [parseWeight, deathWeight, vaultWeight, preparednessWeight, upgradesWeight];
  if (!weights.every((weight) => Number.isInteger(weight) && weight >= 0 && weight <= 100) || weights.reduce((total, weight) => total + weight, 0) !== 100) {
    return new Response('Weights must be whole percentages that add up to 100', { status: 400 });
  }

  const settings = {
    tankQuota: clampInt(input.tankQuota, 2),
    healerQuota: clampInt(input.healerQuota, 5),
    meleeDpsQuota: clampInt(input.meleeDpsQuota, 7),
    rangedDpsQuota: clampInt(input.rangedDpsQuota, 6),
    parseWeight,
    deathWeight,
    vaultWeight,
    preparednessWeight,
    upgradesWeight,
    scale,
  };

  try {
    await regenerateRaidComp(env.DB, settings, context.locals.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Raid Composition regenerate failed', error);
    return new Response('Failed to regenerate', { status: 500 });
  }
}
