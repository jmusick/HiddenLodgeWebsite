export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const REDIRECT_BASE = '/signup';

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return REDIRECT_BASE;
  if (!value.startsWith('/')) return REDIRECT_BASE;
  return value;
}

function statusRedirect(status: string, returnTo: string): Response {
  const sep = returnTo.includes('?') ? '&' : '?';
  return new Response(null, { status: 302, headers: { Location: `${returnTo}${sep}status=${status}` } });
}

function parseInteger(formData: FormData, key: string): number | null {
  const value = Number.parseInt((formData.get(key) as string | null) ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const formData = await context.request.formData();
  const returnTo = safeReturnPath(formData.get('return_to'));

  const raidKindRaw = ((formData.get('raid_kind') as string | null) ?? '').trim().toLowerCase();
  const raidKind = raidKindRaw === 'primary' || raidKindRaw === 'adhoc' ? raidKindRaw : null;
  const primaryScheduleId = parseInteger(formData, 'primary_schedule_id');
  const adHocRaidId = parseInteger(formData, 'ad_hoc_raid_id');
  const occurrenceStartUtc = parseInteger(formData, 'occurrence_start_utc');
  const blizzardCharId = parseInteger(formData, 'blizzard_char_id');
  const action = ((formData.get('bench_action') as string | null) ?? '').trim().toLowerCase();

  if (!raidKind || !occurrenceStartUtc || !blizzardCharId || (action !== 'set' && action !== 'clear')) {
    return statusRedirect('error', returnTo);
  }

  if ((raidKind === 'primary' && !primaryScheduleId) || (raidKind === 'adhoc' && !adHocRaidId)) {
    return statusRedirect('error', returnTo);
  }

  if (raidKind === 'primary' && adHocRaidId) return statusRedirect('error', returnTo);
  if (raidKind === 'adhoc' && primaryScheduleId) return statusRedirect('error', returnTo);

  let canManageBench = context.locals.isAdmin;
  if (!canManageBench) {
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

    canManageBench = Boolean(officerRow?.can_override);
  }

  if (!canManageBench) {
    return new Response('Forbidden', { status: 403 });
  }

  const raidRefKey = raidKind === 'primary' ? `primary:${primaryScheduleId}` : `adhoc:${adHocRaidId}`;

  if (action === 'clear') {
    await env.DB.prepare(
      `DELETE FROM raid_attendance_overrides
       WHERE raid_ref_key = ?
         AND occurrence_start_utc = ?
         AND blizzard_char_id = ?
         AND override_kind = 'bench'`
    )
      .bind(raidRefKey, occurrenceStartUtc, blizzardCharId)
      .run();

    return statusRedirect('bench-cleared', returnTo);
  }

  await env.DB.prepare(
    `INSERT INTO raid_attendance_overrides (
       raid_ref_key,
       raid_kind,
       primary_schedule_id,
       ad_hoc_raid_id,
       occurrence_start_utc,
       blizzard_char_id,
       override_kind,
       note,
       created_by_user_id,
       updated_by_user_id,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'bench', NULL, ?, ?, unixepoch(), unixepoch())
     ON CONFLICT(raid_ref_key, occurrence_start_utc, blizzard_char_id, override_kind) DO UPDATE SET
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`
  )
    .bind(
      raidRefKey,
      raidKind,
      primaryScheduleId,
      adHocRaidId,
      occurrenceStartUtc,
      blizzardCharId,
      user.id,
      user.id
    )
    .run();

  return statusRedirect('bench-updated', returnTo);
}

export async function GET(): Promise<Response> {
  return statusRedirect('error', REDIRECT_BASE);
}
