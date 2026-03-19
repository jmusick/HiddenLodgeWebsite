export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { modeLimit, normalizeTeamMode } from '../../../../lib/raid-teams';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const id = parseInt((formData.get('id') as string | null) ?? '', 10);
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const raidMode = normalizeTeamMode((formData.get('raid_mode') as string | null) ?? null);
  const sortOrderRaw = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

  if (Number.isNaN(id) || !name || name.length > 80 || !raidMode) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS member_count FROM raid_team_members WHERE team_id = ?`
  )
    .bind(id)
    .first<{ member_count: number }>();

  const memberCount = Number(countRow?.member_count ?? 0);
  if (memberCount > modeLimit(raidMode)) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=mode-too-small' } });
  }

  const result = await env.DB.prepare(
    `UPDATE raid_teams
     SET name = ?, raid_mode = ?, sort_order = ?, updated_at = unixepoch()
     WHERE id = ?`
  )
    .bind(name, raidMode, Number.isNaN(sortOrderRaw) ? 0 : sortOrderRaw, id)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=team-updated' } });
}
