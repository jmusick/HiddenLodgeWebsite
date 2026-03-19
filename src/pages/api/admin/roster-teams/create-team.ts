export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeTeamMode } from '../../../../lib/raid-teams';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const sortOrderRaw = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);
  const raidMode = normalizeTeamMode((formData.get('raid_mode') as string | null) ?? null);

  if (!name || name.length > 80 || !raidMode) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  await env.DB.prepare(
    `INSERT INTO raid_teams (name, raid_mode, sort_order, updated_at) VALUES (?, ?, ?, unixepoch())`
  )
    .bind(name, raidMode, Number.isNaN(sortOrderRaw) ? 0 : sortOrderRaw)
    .run();

  return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=team-created' } });
}
