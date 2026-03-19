export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { modeLimit, normalizeAssignedRole, normalizeTeamMode } from '../../../../lib/raid-teams';

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

  const teamRow = await env.DB.prepare(`SELECT raid_mode FROM raid_teams WHERE id = ?`)
    .bind(teamId)
    .first<{ raid_mode: string }>();

  const raidMode = normalizeTeamMode(teamRow?.raid_mode);
  if (!raidMode) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=error' } });
  }

  const charRow = await env.DB.prepare(
    `SELECT level FROM roster_members_cache WHERE blizzard_char_id = ?`
  )
    .bind(blizzardCharId)
    .first<{ level: number }>();

  if (!charRow || Number(charRow.level) !== 90) {
    return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=must-be-90' } });
  }

  const existsRow = await env.DB.prepare(
    `SELECT 1 AS found FROM raid_team_members WHERE team_id = ? AND blizzard_char_id = ?`
  )
    .bind(teamId, blizzardCharId)
    .first<{ found: number }>();

  if (!existsRow) {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS member_count FROM raid_team_members WHERE team_id = ?`
    )
      .bind(teamId)
      .first<{ member_count: number }>();

    const memberCount = Number(countRow?.member_count ?? 0);
    if (memberCount >= modeLimit(raidMode)) {
      return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=team-full' } });
    }
  }

  await env.DB.prepare(
    `INSERT INTO raid_team_members (team_id, blizzard_char_id, assigned_role, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(team_id, blizzard_char_id) DO UPDATE SET
       assigned_role = excluded.assigned_role,
       updated_at = unixepoch()`
  )
    .bind(teamId, blizzardCharId, assignedRole)
    .run();

  return new Response(null, { status: 302, headers: { Location: '/admin/roster-teams?status=member-added' } });
}
