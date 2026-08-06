// US region weekly reset: Tuesday 11:00 AM America/New_York (Eastern).
// This is the single source of truth for "this week" / "last week" cutoffs
// used across M+ run counts, Great Vault snapshots, keystone history, and
// preparedness tracking — keep every consumer importing from here so they
// can't drift out of sync with each other or with the actual reset time.
export const US_WEEKLY_RESET_HOUR_EASTERN = 11;
export const WEEK_SECONDS = 7 * 24 * 60 * 60;

function easternUtcOffsetMinutes(atUtc: Date): number {
  // Derive the UTC offset by comparing the Eastern local time components to UTC.
  // This avoids relying on `timeZoneName: 'shortOffset'` (an ES2021 addition that is not
  // universally supported) and the regex dance that follows it.
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(atUtc);

  const nyYear   = Number(nyParts.find((p) => p.type === 'year')?.value   ?? '1970');
  const nyMonth  = Number(nyParts.find((p) => p.type === 'month')?.value  ?? '1');
  const nyDay    = Number(nyParts.find((p) => p.type === 'day')?.value    ?? '1');
  const nyHour   = Number(nyParts.find((p) => p.type === 'hour')?.value   ?? '0');
  const nyMinute = Number(nyParts.find((p) => p.type === 'minute')?.value ?? '0');
  const nySecond = Number(nyParts.find((p) => p.type === 'second')?.value ?? '0');

  // Treat the Eastern wall-clock reading as if it were UTC, then subtract the true UTC ms.
  const nyAsUtcMs = Date.UTC(nyYear, nyMonth - 1, nyDay, nyHour, nyMinute, nySecond);
  return Math.round((nyAsUtcMs - atUtc.getTime()) / 60_000);
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Unix timestamp (seconds) of the most recent US weekly reset (Tuesday 11:00 AM Eastern) at or before now. */
export function getUsWeeklyResetTimestamp(): number {
  const now = new Date();
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const weekdayShort = nowParts.find((part) => part.type === 'weekday')?.value ?? 'Tue';
  const year = Number(nowParts.find((part) => part.type === 'year')?.value ?? '1970');
  const month = Number(nowParts.find((part) => part.type === 'month')?.value ?? '1');
  const day = Number(nowParts.find((part) => part.type === 'day')?.value ?? '1');

  const dayIndex = WEEKDAY_TO_INDEX[weekdayShort] ?? 2;
  const daysSinceTuesday = (dayIndex - 2 + 7) % 7;

  const localResetSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday, US_WEEKLY_RESET_HOUR_EASTERN, 0, 0, 0));
  const offsetMinutes = easternUtcOffsetMinutes(localResetSeedUtc);
  let resetUtc = new Date(localResetSeedUtc.getTime() - offsetMinutes * 60 * 1000);

  if (resetUtc > now) {
    const previousWeekLocalSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday - 7, US_WEEKLY_RESET_HOUR_EASTERN, 0, 0, 0));
    const previousWeekOffsetMinutes = easternUtcOffsetMinutes(previousWeekLocalSeedUtc);
    resetUtc = new Date(previousWeekLocalSeedUtc.getTime() - previousWeekOffsetMinutes * 60 * 1000);
  }

  return Math.floor(resetUtc.getTime() / 1000);
}

/** Convert an America/New_York wall-clock date/time to a Unix timestamp (seconds), DST-aware. */
function easternWallClockToUtcSeconds(year: number, month1to12: number, day: number, hour: number, minute = 0): number {
  const seedUtc = new Date(Date.UTC(year, month1to12 - 1, day, hour, minute, 0));
  const offsetMinutes = easternUtcOffsetMinutes(seedUtc);
  return Math.floor((seedUtc.getTime() - offsetMinutes * 60_000) / 1000);
}

// Midnight Season 2 begins Tuesday 2026-08-18 at 1:00 AM Eastern. No new per-raider
// tracking data (gear/ilvl, M+ score, crests, keystones, Great Vault, or any
// *_history snapshot) should be recorded before this instant, even if the refresh
// cron or admin "Refresh Now" runs earlier (e.g. during patch-week testing).
export const SEASON_2_START_TIMESTAMP = easternWallClockToUtcSeconds(2026, 8, 18, 1, 0);
