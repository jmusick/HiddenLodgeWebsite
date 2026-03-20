export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeRepeatCycle, parseUtcTime } from '../../../../lib/raid-signups';

const REDIRECT_BASE = '/admin/raid-signups';

function statusRedirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${REDIRECT_BASE}?status=${status}` } });
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const repeatCycle = normalizeRepeatCycle((formData.get('repeat_cycle') as string | null) ?? null);

  const weekdays = formData.getAll('weekday_utc[]');
  const startTimes = formData.getAll('start_time_utc[]');
  const endTimes = formData.getAll('end_time_utc[]');

  if (!name || name.length > 80 || !repeatCycle) {
    return statusRedirect('error');
  }

  if (weekdays.length === 0 || weekdays.length !== startTimes.length || startTimes.length !== endTimes.length) {
    return statusRedirect('error');
  }

  const parsedEntries: Array<{ weekdayUtc: number; startTimeUtc: string; durationMinutes: number }> = [];
  const dedupe = new Set<string>();

  for (let i = 0; i < weekdays.length; i += 1) {
    const weekdayRaw = weekdays[i];
    const startRaw = startTimes[i];
    const endRaw = endTimes[i];

    if (typeof weekdayRaw !== 'string' || typeof startRaw !== 'string' || typeof endRaw !== 'string') {
      return statusRedirect('error');
    }

    const weekdayUtc = Number.parseInt(weekdayRaw, 10);
    const startTimeUtc = startRaw.trim();
    const endTimeUtc = endRaw.trim();
    const parsedStart = parseUtcTime(startTimeUtc);
    const parsedEnd = parseUtcTime(endTimeUtc);

    if (!Number.isInteger(weekdayUtc) || weekdayUtc < 0 || weekdayUtc > 6 || !parsedStart || !parsedEnd) {
      return statusRedirect('error');
    }

    const startMinutes = parsedStart.hour * 60 + parsedStart.minute;
    const endMinutes = parsedEnd.hour * 60 + parsedEnd.minute;
    let durationMinutes = endMinutes - startMinutes;
    if (durationMinutes <= 0) {
      durationMinutes += 24 * 60;
    }

    if (durationMinutes < 30 || durationMinutes > 720) {
      return statusRedirect('error');
    }

    const key = `${weekdayUtc}:${startTimeUtc}:${durationMinutes}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    parsedEntries.push({ weekdayUtc, startTimeUtc, durationMinutes });
  }

  if (parsedEntries.length === 0) {
    return statusRedirect('error');
  }

  await env.DB.batch(
    parsedEntries.map((entry) =>
      env.DB.prepare(
        `INSERT INTO primary_raid_schedules
          (name, weekday_utc, start_time_utc, duration_minutes, repeat_cycle, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, unixepoch())`
      ).bind(name, entry.weekdayUtc, entry.startTimeUtc, entry.durationMinutes, repeatCycle)
    )
  );

  return statusRedirect('primary-created');
}
