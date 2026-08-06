export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!FEATURE_FLAGS.rosterTeams) {
    return new Response('Not found', { status: 404 });
  }

  const formData = await context.request.formData();
  const id = parseInt((formData.get('id') as string | null) ?? '', 10);

  if (Number.isNaN(id)) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  const result = await env.DB.prepare(`DELETE FROM raid_teams WHERE id = ?`).bind(id).run();

  if (!result.success || result.meta.changes === 0) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=team-deleted' } });
}
