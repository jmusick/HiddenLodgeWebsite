const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
] as const;

export const DEFAULT_MEMBER_TIME_ZONE = 'America/New_York';

interface UserTimeZonePreference {
  time_zone?: string | null;
  time_zone_set?: number | null;
}

function hasSupportedValuesOf(): boolean {
  return typeof Intl.supportedValuesOf === 'function';
}

export function getSupportedTimeZones(): string[] {
  const zones = hasSupportedValuesOf() ? Intl.supportedValuesOf('timeZone') : [...FALLBACK_TIME_ZONES];

  const unique = new Set(zones);
  unique.add('UTC');

  return [...unique].sort((a, b) => {
    if (a === 'UTC') return -1;
    if (b === 'UTC') return 1;
    return a.localeCompare(b);
  });
}

export function isValidTimeZone(value: string): boolean {
  if (!value) return false;

  if (hasSupportedValuesOf()) {
    return value === 'UTC' || Intl.supportedValuesOf('timeZone').includes(value);
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function resolveUserTimeZone(preference?: UserTimeZonePreference): string {
  const selectedTimeZone = preference?.time_zone?.trim() ?? '';
  const hasExplicitPreference = preference?.time_zone_set === 1;

  if (!hasExplicitPreference) {
    return DEFAULT_MEMBER_TIME_ZONE;
  }

  if (selectedTimeZone && isValidTimeZone(selectedTimeZone)) {
    return selectedTimeZone;
  }

  return DEFAULT_MEMBER_TIME_ZONE;
}

export function timeZoneLabel(timeZone: string): string {
  if (timeZone === 'UTC') return 'UTC';
  return timeZone.replaceAll('_', ' ');
}
