export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeAssignedRole } from '../../../../lib/raid-teams';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const teamId = parseInt((formData.get('team_id') as string | null) ?? '', 10);
  const blizzardCharId = parseInt((formData.get('blizzard_char_id') as string | null) ?? '', 10);
  const assignedRole = normalizeAssignedRole((formData.get('assigned_role') as string | null) ?? null);

  if (Number.isNaN(teamId) || Number.isNaN(blizzardCharId) || !assignedRole) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  const result = await env.DB.prepare(
    `UPDATE raid_team_members SET assigned_role = ?, updated_at = unixepoch()
     WHERE team_id = ? AND blizzard_char_id = ?`
  )
    .bind(assignedRole, teamId, blizzardCharId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=member-updated' } });
}
