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

export function timeZoneLabel(timeZone: string): string {
  if (timeZone === 'UTC') return 'UTC';
  return timeZone.replaceAll('_', ' ');
}
