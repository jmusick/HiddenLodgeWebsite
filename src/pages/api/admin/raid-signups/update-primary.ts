export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeRepeatCycle, parseUtcTime } from '../../../../lib/raid-signups';

const REDIRECT_BASE = '/admin/raid-signups';

function statusRedirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${REDIRECT_BASE}?status=${status}` } });
}

export async function GET(): Promise<Response> {
  return statusRedirect('error');
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const id = Number.parseInt((formData.get('id') as string | null) ?? '', 10);
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const weekdayUtc = Number.parseInt((formData.get('weekday_utc') as string | null) ?? '', 10);
  const startTimeUtc = (formData.get('start_time_utc') as string | null)?.trim() ?? '';
  const endTimeUtc = (formData.get('end_time_utc') as string | null)?.trim() ?? '';
  const repeatCycle = normalizeRepeatCycle((formData.get('repeat_cycle') as string | null) ?? null);

  if (!Number.isInteger(id) || id <= 0) return statusRedirect('error');
  if (!name || name.length > 80) return statusRedirect('error');
  if (!Number.isInteger(weekdayUtc) || weekdayUtc < 0 || weekdayUtc > 6) return statusRedirect('error');

  const parsedStart = parseUtcTime(startTimeUtc);
  const parsedEnd = parseUtcTime(endTimeUtc);
  if (!parsedStart || !parsedEnd || !repeatCycle) return statusRedirect('error');

  const startMinutes = parsedStart.hour * 60 + parsedStart.minute;
  const endMinutes = parsedEnd.hour * 60 + parsedEnd.minute;
  let durationMinutes = endMinutes - startMinutes;
  if (durationMinutes <= 0) {
    durationMinutes += 24 * 60;
  }

  if (durationMinutes < 30 || durationMinutes > 720) return statusRedirect('error');

  await env.DB.prepare(
    `UPDATE primary_raid_schedules
     SET name = ?, weekday_utc = ?, start_time_utc = ?, duration_minutes = ?, repeat_cycle = ?, updated_at = unixepoch()
     WHERE id = ?`
  )
    .bind(name, weekdayUtc, startTimeUtc, durationMinutes, repeatCycle, id)
    .run();

  return statusRedirect('primary-updated');
}
