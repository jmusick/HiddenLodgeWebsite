export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getAttendanceLogCandidatesForOccurrence } from '../../../../lib/attendance';

async function canManageLogMatching(context: APIContext): Promise<boolean> {
  if (context.locals.isAdmin) return true;

  const user = context.locals.user;
  if (!user) return false;

  const officerRow = await env.DB.prepare(
    `SELECT 1 AS can_override
     FROM characters c
     JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
     WHERE c.user_id = ?
       AND rmc.rank IN (0, 1, 2, 3)
     LIMIT 1`
  )
    .bind(user.id)
    .first<{ can_override: number }>();

  return Boolean(officerRow?.can_override);
}

function parsePositiveInt(raw: string | null): number | null {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(context: APIContext): Promise<Response> {
  const canManage = await canManageLogMatching(context);
  if (!canManage) return new Response('Forbidden', { status: 403 });

  const url = new URL(context.request.url);
  const occurrenceStartUtc = parsePositiveInt(url.searchParams.get('occurrence_start_utc'));
  const durationMinutes = parsePositiveInt(url.searchParams.get('duration_minutes')) ?? 180;

  if (!occurrenceStartUtc) {
    return Response.json({ error: 'Missing occurrence_start_utc' }, { status: 400 });
  }

  try {
    const candidates = await getAttendanceLogCandidatesForOccurrence(
      env.DB,
      occurrenceStartUtc,
      durationMinutes
    );

    return Response.json({
      candidates: candidates.map((row) => ({
        code: row.code,
        startUtc: row.startUtc,
        endUtc: row.endUtc,
        reportUrl: `https://www.warcraftlogs.com/reports/${row.code}`,
      })),
    });
  } catch (error) {
    console.error('Failed to load attendance log candidates', error);
    return Response.json({ error: 'Failed to load candidates' }, { status: 500 });
  }
}
