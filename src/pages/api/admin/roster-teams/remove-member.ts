export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const teamId = parseInt((formData.get('team_id') as string | null) ?? '', 10);
  const blizzardCharId = parseInt((formData.get('blizzard_char_id') as string | null) ?? '', 10);
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

  if (Number.isNaN(teamId) || Number.isNaN(blizzardCharId)) {
    return redirectWith('error');
  }

  const result = await env.DB.prepare(
    `DELETE FROM raid_team_members WHERE team_id = ? AND blizzard_char_id = ?`
  )
    .bind(teamId, blizzardCharId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return redirectWith('error');
  }

  return redirectWith('member-removed');
}
