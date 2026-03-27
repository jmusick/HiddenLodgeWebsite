export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeAssignedRole } from '../../../lib/raid-teams';

function parsePositiveInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return '/signup';
  if (!value.startsWith('/')) return '/signup';
  return value;
}

const VALID_ATTENDANCE_STATUSES = new Set(['coming', 'tentative', 'late', 'absent']);

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const raidKind = (formData.get('raid_kind') as string | null) ?? '';
  const attendanceStatus = (formData.get('attendance_status') as string | null) ?? '';
  const signupRole = normalizeAssignedRole((formData.get('signup_role') as string | null) ?? null);
  const characterId = parsePositiveInt(formData.get('character_id'));
  const returnTo = safeReturnPath(formData.get('return_to'));
  const signupNotes = (formData.get('signup_notes') as string | null)?.trim() || null;

  if (
    !characterId ||
    (raidKind !== 'primary' && raidKind !== 'adhoc') ||
    !VALID_ATTENDANCE_STATUSES.has(attendanceStatus) ||
    !signupRole
  ) {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  // Late status requires a note
  if (attendanceStatus === 'late' && !signupNotes) {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  const ownsCharacter = await env.DB.prepare('SELECT 1 FROM characters WHERE id = ? AND user_id = ?')
    .bind(characterId, user.id)
    .first();

  if (!ownsCharacter) {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  try {
    if (raidKind === 'primary') {
      const primaryScheduleId = parsePositiveInt(formData.get('primary_schedule_id'));
      const occurrenceStartUtc = parsePositiveInt(formData.get('occurrence_start_utc'));
      if (!primaryScheduleId || !occurrenceStartUtc) {
        throw new Error('Invalid primary signup payload');
      }

      const schedule = await env.DB.prepare('SELECT id FROM primary_raid_schedules WHERE id = ? AND is_active = 1')
        .bind(primaryScheduleId)
        .first();
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM raid_signups
           WHERE user_id = ?
             AND primary_schedule_id = ?
             AND occurrence_start_utc = ?`
        ).bind(user.id, primaryScheduleId, occurrenceStartUtc),
        env.DB.prepare(
          `INSERT INTO raid_signups
             (user_id, character_id, raid_kind, primary_schedule_id, occurrence_start_utc, signup_status, signup_role, signup_notes, signed_up_at, updated_at)
           VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
        ).bind(user.id, characterId, primaryScheduleId, occurrenceStartUtc, attendanceStatus, signupRole, signupNotes),
      ]);
    } else {
      const adHocRaidId = parsePositiveInt(formData.get('ad_hoc_raid_id'));
      if (!adHocRaidId) {
        throw new Error('Invalid ad-hoc signup payload');
      }

      const raid = await env.DB.prepare('SELECT id FROM ad_hoc_raids WHERE id = ? AND is_active = 1')
        .bind(adHocRaidId)
        .first();
      if (!raid) {
        throw new Error('Raid not found');
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM raid_signups WHERE user_id = ? AND ad_hoc_raid_id = ?').bind(user.id, adHocRaidId),
        env.DB.prepare(
          `INSERT INTO raid_signups
             (user_id, character_id, raid_kind, ad_hoc_raid_id, signup_status, signup_role, signup_notes, signed_up_at, updated_at)
           VALUES (?, ?, 'adhoc', ?, ?, ?, ?, unixepoch(), unixepoch())`
        ).bind(user.id, characterId, adHocRaidId, attendanceStatus, signupRole, signupNotes),
      ]);
    }
  } catch {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=signed` } });
}
