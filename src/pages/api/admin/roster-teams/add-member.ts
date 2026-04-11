export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeAssignedRole, normalizeTeamMode } from '../../../../lib/raid-teams';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const teamId = parseInt((formData.get('team_id') as string | null) ?? '', 10);
  const blizzardCharId = parseInt((formData.get('blizzard_char_id') as string | null) ?? '', 10);
  const assignedRole = normalizeAssignedRole((formData.get('assigned_role') as string | null) ?? null);
  const openTeamId = parseInt((formData.get('open_team') as string | null) ?? '', 10);
  const openPickerId = parseInt((formData.get('open_picker') as string | null) ?? '', 10);

  const redirectWith = (status: string): Response => {
    const resolvedTeamId = Number.isInteger(openTeamId) && openTeamId > 0 ? openTeamId : teamId;
    const resolvedPickerId = Number.isInteger(openPickerId) && openPickerId > 0 ? openPickerId : teamId;
    const openTeam = Number.isInteger(resolvedTeamId) && resolvedTeamId > 0 ? `&open_team=${resolvedTeamId}` : '';
    const openPicker = Number.isInteger(resolvedPickerId) && resolvedPickerId > 0 ? `&open_picker=${resolvedPickerId}` : '';
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/roster-teams?status=${status}${openTeam}${openPicker}` },
    });
  };

  if (Number.isNaN(teamId) || Number.isNaN(blizzardCharId) || !assignedRole) {
    return redirectWith('error');
  }

  const teamRow = await env.DB.prepare(`SELECT raid_mode FROM raid_teams WHERE id = ?`)
    .bind(teamId)
    .first<{ raid_mode: string }>();

  const raidMode = normalizeTeamMode(teamRow?.raid_mode);
  if (!raidMode) {
    return redirectWith('error');
  }

  const charRow = await env.DB.prepare(
    `SELECT level FROM roster_members_cache WHERE blizzard_char_id = ?`
  )
    .bind(blizzardCharId)
    .first<{ level: number }>();

  if (!charRow || Number(charRow.level) !== 90) {
    return redirectWith('must-be-90');
  }

  await env.DB.prepare(
    `SELECT 1 AS found FROM raid_team_members WHERE team_id = ? AND blizzard_char_id = ?`
  )
    .bind(teamId, blizzardCharId)
    .first<{ found: number }>();

  await env.DB.prepare(
    `INSERT INTO raid_team_members (team_id, blizzard_char_id, assigned_role, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(team_id, blizzard_char_id) DO UPDATE SET
       assigned_role = excluded.assigned_role,
       updated_at = unixepoch()`
  )
    .bind(teamId, blizzardCharId, assignedRole)
    .run();

  return redirectWith('member-added');
}
