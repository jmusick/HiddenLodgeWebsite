export type RaidKind = 'primary' | 'adhoc';
export type RepeatCycle = 'weekly' | 'biweekly';

export interface PrimarySchedule {
  id: number;
  name: string;
  weekday_utc: number;
  start_time_utc: string;
  duration_minutes: number;
  repeat_cycle: RepeatCycle;
  created_at: number;
  is_active: number;
}

export interface AdHocRaid {
  id: number;
  name: string;
  starts_at_utc: number;
  duration_minutes: number;
  notes: string | null;
  is_active: number;
}

export function parseUtcTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

export function weekdayLabel(weekdayUtc: number): string {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return labels[weekdayUtc] ?? `Day ${weekdayUtc}`;
}

export function normalizeRepeatCycle(value: string | null | undefined): RepeatCycle | null {
  if (value === 'weekly' || value === 'biweekly') return value;
  return null;
}

export function repeatCycleLabel(cycle: RepeatCycle): string {
  if (cycle === 'biweekly') return 'Every 2 weeks';
  return 'Weekly';
}

export function startOfUtcDay(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

export function toIsoYm(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function parseYm(ym: string | null): { year: number; monthIndex: number } | null {
  if (!ym) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { year, monthIndex: month - 1 };
}

export function monthGridUtc(year: number, monthIndex: number): {
  monthStart: Date;
  monthEndExclusive: Date;
  gridStart: Date;
  gridEndExclusive: Date;
  prevYm: string;
  nextYm: string;
} {
  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEndExclusive = new Date(Date.UTC(year, monthIndex + 1, 1));
  const monthStartWeekday = monthStart.getUTCDay();
  const gridStart = new Date(Date.UTC(year, monthIndex, 1 - monthStartWeekday));

  const endWeekday = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDay();
  const trailing = 6 - endWeekday;
  const gridEndExclusive = new Date(Date.UTC(year, monthIndex + 1, 1 + trailing));

  const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));

  return {
    monthStart,
    monthEndExclusive,
    gridStart,
    gridEndExclusive,
    prevYm: toIsoYm(prev),
    nextYm: toIsoYm(next),
  };
}

export function formatEpochInTimeZone(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

export function dayKeyInTimeZone(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

export function utcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;
}

function firstOccurrenceDayStartUtc(createdAtEpoch: number, weekdayUtc: number): number {
  const created = new Date(createdAtEpoch * 1000);
  const createdDayStart = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()) / 1000;
  const deltaDays = (weekdayUtc - created.getUTCDay() + 7) % 7;
  return createdDayStart + deltaDays * 86400;
}

export function shouldScheduleOccurOnUtcDate(schedule: PrimarySchedule, dateUtc: Date): boolean {
  if (schedule.weekday_utc !== dateUtc.getUTCDay()) return false;

  const cycle = normalizeRepeatCycle(schedule.repeat_cycle) ?? 'weekly';
  if (cycle === 'weekly') return true;

  const dateStart = Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()) / 1000;
  const firstStart = firstOccurrenceDayStartUtc(schedule.created_at, schedule.weekday_utc);
  if (dateStart < firstStart) return false;

  const weeksSinceFirst = Math.floor((dateStart - firstStart) / (7 * 86400));
  return weeksSinceFirst % 2 === 0;
}
