export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isBenchRole, setBenchRoleOverride } from '../../../../lib/bench';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/admin/bench?status=${status}` } });
}

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  const formData = await context.request.formData();
  const blizzardCharId = Number.parseInt(String(formData.get('blizzard_char_id') ?? ''), 10);
  if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) return redirect('error');

  // Empty role = back to automatic.
  const rawRole = String(formData.get('role') ?? '').trim();
  if (rawRole && !isBenchRole(rawRole)) return redirect('error');

  try {
    await setBenchRoleOverride(env.DB, blizzardCharId, isBenchRole(rawRole) ? rawRole : null, user.id);
    return redirect('role-saved');
  } catch (error) {
    console.error('Bench role override failed', error);
    return redirect('error');
  }
}
