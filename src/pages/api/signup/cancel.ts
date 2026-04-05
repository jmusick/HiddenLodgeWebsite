export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

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

function redirectWithStatus(returnTo: string, status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=${status}` },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const raidKind = (formData.get('raid_kind') as string | null) ?? '';
  const returnTo = safeReturnPath(formData.get('return_to'));
  const nowEpoch = Math.floor(Date.now() / 1000);

  try {
    if (raidKind === 'primary') {
      const primaryScheduleId = parsePositiveInt(formData.get('primary_schedule_id'));
      const occurrenceStartUtc = parsePositiveInt(formData.get('occurrence_start_utc'));
      if (!primaryScheduleId || !occurrenceStartUtc) {
        throw new Error('Invalid primary cancellation payload');
      }

      if (occurrenceStartUtc <= nowEpoch) {
        return redirectWithStatus(returnTo, 'locked');
      }

      await env.DB.prepare(
        `DELETE FROM raid_signups
         WHERE user_id = ?
           AND raid_kind = 'primary'
           AND primary_schedule_id = ?
           AND occurrence_start_utc = ?`
      )
        .bind(user.id, primaryScheduleId, occurrenceStartUtc)
        .run();
    } else if (raidKind === 'adhoc') {
      const adHocRaidId = parsePositiveInt(formData.get('ad_hoc_raid_id'));
      if (!adHocRaidId) {
        throw new Error('Invalid ad-hoc cancellation payload');
      }

      const raid = await env.DB.prepare('SELECT starts_at_utc FROM ad_hoc_raids WHERE id = ?')
        .bind(adHocRaidId)
        .first<{ starts_at_utc: number }>();
      if (!raid) {
        throw new Error('Raid not found');
      }

      if (raid.starts_at_utc <= nowEpoch) {
        return redirectWithStatus(returnTo, 'locked');
      }

      await env.DB.prepare(
        `DELETE FROM raid_signups
         WHERE user_id = ?
           AND raid_kind = 'adhoc'
           AND ad_hoc_raid_id = ?`
      )
        .bind(user.id, adHocRaidId)
        .run();
    } else {
      throw new Error('Invalid raid kind');
    }
  } catch {
    return redirectWithStatus(returnTo, 'error');
  }

  return redirectWithStatus(returnTo, 'canceled');
}
