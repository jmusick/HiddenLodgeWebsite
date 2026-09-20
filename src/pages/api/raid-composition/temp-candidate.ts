export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { createTempRaidCompCandidate, deleteTempRaidCompCandidate, type AssignedRole } from '../../../lib/raid-comp';
import { CLASS_COLORS } from '../../../lib/wow';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

const ROLES = new Set<AssignedRole>(['tank', 'healer', 'melee-dps', 'ranged-dps']);

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}

/** Adds or removes an officer-managed PUG/trial candidate without creating a Blizzard character record. */
export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis || !FEATURE_FLAGS.raidComp) return new Response('Not found', { status: 404 });

  const form = await context.request.formData();
  const action = String(form.get('action') ?? '');
  try {
    if (action === 'delete') {
      const id = Number(form.get('candidate_id'));
      if (!Number.isInteger(id) || id <= 0) return redirect('error');
      await deleteTempRaidCompCandidate(env.DB, id);
      return redirect('temp-candidate-removed');
    }

    const name = String(form.get('name') ?? '').trim();
    const className = String(form.get('class_name') ?? '');
    const assignedRole = String(form.get('assigned_role') ?? '') as AssignedRole;
    if (!name || name.length > 40 || !Object.hasOwn(CLASS_COLORS, className) || !ROLES.has(assignedRole)) return redirect('error');
    await createTempRaidCompCandidate(env.DB, { name, className, assignedRole }, user.id);
    return redirect('temp-candidate-added');
  } catch (error) {
    console.error('Temporary Raid Composition candidate update failed', error);
    return redirect('error');
  }
}
