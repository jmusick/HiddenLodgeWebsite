export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { rematchAttendanceOccurrence } from '../../../../lib/attendance';

const REDIRECT_BASE = '/admin/log-matching';

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

function parseReportCode(rawValue: string): string | null {
  const raw = rawValue.trim();
  if (!raw) return null;

  const urlMatch = raw.match(/warcraftlogs\.com\/reports\/([A-Za-z0-9]+)/i);
  const candidate = urlMatch?.[1] ?? raw;
  return /^[A-Za-z0-9]+$/.test(candidate) ? candidate : null;
}

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
  const scheduledDurationMinutes = parseInteger(formData, 'scheduled_duration_minutes') ?? 180;
  const selectedReportCode =
    parseReportCode(((formData.get('report_code_manual') as string | null) ?? '')) ??
    parseReportCode(((formData.get('report_code') as string | null) ?? ''));

  if (!raidKind || !occurrenceStartUtc) {
    return statusRedirect('error', returnTo);
  }

  if ((raidKind === 'primary' && !primaryScheduleId) || (raidKind === 'adhoc' && !adHocRaidId)) {
    return statusRedirect('error', returnTo);
  }

  if (raidKind === 'primary' && adHocRaidId) return statusRedirect('error', returnTo);
  if (raidKind === 'adhoc' && primaryScheduleId) return statusRedirect('error', returnTo);

  const canManage = await canManageLogMatching(context);
  if (!canManage) return new Response('Forbidden', { status: 403 });

  const raidRefKey = raidKind === 'primary' ? `primary:${primaryScheduleId}` : `adhoc:${adHocRaidId}`;

  try {
    if (!selectedReportCode) {
      await env.DB.prepare(
        `DELETE FROM raid_attendance_log_overrides
         WHERE raid_ref_key = ?
           AND occurrence_start_utc = ?`
      )
        .bind(raidRefKey, occurrenceStartUtc)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO raid_attendance_log_overrides (
           raid_ref_key,
           occurrence_start_utc,
           report_code,
           created_by_user_id,
           updated_by_user_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
         ON CONFLICT(raid_ref_key, occurrence_start_utc) DO UPDATE SET
           report_code = excluded.report_code,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = excluded.updated_at`
      )
        .bind(raidRefKey, occurrenceStartUtc, selectedReportCode, user.id, user.id)
        .run();
    }

    try {
      await rematchAttendanceOccurrence(env.DB, {
        raidKind,
        primaryScheduleId,
        adHocRaidId,
        occurrenceStartUtc,
        scheduledDurationMinutes,
      });
      return statusRedirect(selectedReportCode ? 'log-match-updated' : 'log-match-cleared', returnTo);
    } catch (syncError) {
      console.error('Saved attendance log override but rematch failed', syncError);
      const syncMessage = syncError instanceof Error ? syncError.message : '';
      const isBackoff =
        syncMessage.toLowerCase().includes('backoff active until') ||
        syncMessage.toLowerCase().includes('rate limit');
      if (isBackoff) {
        return statusRedirect(selectedReportCode ? 'log-match-updated-sync-backoff' : 'log-match-cleared-sync-backoff', returnTo);
      }
      return statusRedirect(selectedReportCode ? 'log-match-updated-sync-pending' : 'log-match-cleared-sync-pending', returnTo);
    }
  } catch (error) {
    console.error('Failed to update attendance log match override', error);
    return statusRedirect('error', returnTo);
  }
}

export async function GET(): Promise<Response> {
  return statusRedirect('error', REDIRECT_BASE);
}
