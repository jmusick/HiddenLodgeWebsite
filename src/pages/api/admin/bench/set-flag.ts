export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { setBenchAbsent, setBenchMeleeRangedOverride, setBenchRaidLeader } from '../../../../lib/bench';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

const FIELDS = new Set(['melee_ranged', 'absent', 'raid_leader']);

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}

/** One endpoint for all three bench_flags columns (Roster panel's melee/ranged override, Absent, and RL toggles). */
export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  const formData = await context.request.formData();
  const blizzardCharId = Number.parseInt(String(formData.get('blizzard_char_id') ?? ''), 10);
  if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) return redirect('error');

  const field = String(formData.get('field') ?? '');
  if (!FIELDS.has(field)) return redirect('error');
  const rawValue = String(formData.get('value') ?? '').trim();

  try {
    if (field === 'melee_ranged') {
      if (rawValue && rawValue !== 'melee' && rawValue !== 'ranged') return redirect('error');
      await setBenchMeleeRangedOverride(env.DB, blizzardCharId, rawValue === 'melee' || rawValue === 'ranged' ? rawValue : null, user.id);
    } else if (field === 'absent') {
      await setBenchAbsent(env.DB, blizzardCharId, rawValue === 'true', user.id);
    } else {
      await setBenchRaidLeader(env.DB, blizzardCharId, rawValue === 'true', user.id);
    }
    return redirect('flag-saved');
  } catch (error) {
    console.error('Bench flag update failed', error);
    return redirect('error');
  }
}
