export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { clearAllAbsent } from '../../../../lib/bench';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/raid-composition?status=${status}` } });
}

/** Clears everyone's Absent flag at once — for starting a fresh raid night. */
export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isOfficer) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });

  try {
    await clearAllAbsent(env.DB, user.id);
    return redirect('flag-saved');
  } catch (error) {
    console.error('Reset Absent failed', error);
    return redirect('error');
  }
}
