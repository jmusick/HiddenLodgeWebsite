import { getRaiderIoConfig } from './runtime-env';

const RAIDER_IO_BASE = 'https://raider.io/api/v1';
const DEFAULT_REGION = 'us';
const RAIDER_IO_INTERNAL_API_BASE = 'https://raider.io/api';
const MIDNIGHT_SEASON_SLUG = 'season-mn-1';
const MIDNIGHT_CURRENT_TIER = '35';
const MIDNIGHT_SEASON_1_START_TIMESTAMP = Math.floor(Date.UTC(2026, 2, 24, 15, 0, 0, 0) / 1000);
const WEEK_SECONDS = 7 * 24 * 60 * 60;

interface RaiderIoKeystoneRun {
  keystone_run_id?: number;
  keystone_level?: number;
  mythic_level?: number;
  map_challenge_mode_id?: number;
  completed_at?: string;
  completed_at_timestamp?: number;
}

interface RaiderIoCharacterProfileResponse {
  mythic_plus_best_runs?: RaiderIoKeystoneRun[];
  mythic_plus_alternate_runs?: RaiderIoKeystoneRun[];
  mythic_plus_recent_runs?: RaiderIoKeystoneRun[];
  mythic_plus_highest_level_runs?: RaiderIoKeystoneRun[];
  mythic_plus_weekly_highest_level_runs?: RaiderIoKeystoneRun[];
  mythic_plus_previous_weekly_highest_level_runs?: RaiderIoKeystoneRun[];
}

interface RaiderIoCharacterDetailsResponse {
  characterDetails?: {
    character?: {
      id?: number;
    };
  };
}

interface RaiderIoStatisticsRunsRow {
  quantity?: number;
}

interface RaiderIoStatisticsResponse {
  data?: RaiderIoStatisticsRunsRow[];
}

function buildCharacterProfileUrl(realm: string, name: string): string {
  const url = new URL(`${RAIDER_IO_BASE}/characters/profile`);
  url.searchParams.set('region', DEFAULT_REGION);
  url.searchParams.set('realm', realm);
  url.searchParams.set('name', name);
  url.searchParams.set(
    'fields',
    [
      'mythic_plus_best_runs:all',
      'mythic_plus_alternate_runs:all',
      'mythic_plus_recent_runs',
      'mythic_plus_highest_level_runs',
      'mythic_plus_weekly_highest_level_runs',
      'mythic_plus_previous_weekly_highest_level_runs',
    ].join(',')
  );

  const { accessKey } = getRaiderIoConfig();
  if (accessKey) {
    url.searchParams.set('access_key', accessKey);
  }

  return url.toString();
}

function buildCharacterDetailsUrl(realm: string, name: string): string {
  const url = new URL(`${RAIDER_IO_INTERNAL_API_BASE}/characters/${DEFAULT_REGION}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`);
  url.searchParams.set('season', MIDNIGHT_SEASON_SLUG);
  url.searchParams.set('tier', MIDNIGHT_CURRENT_TIER);
  return url.toString();
}

function getCurrentSeasonWeek(nowTs: number): number {
  if (nowTs <= MIDNIGHT_SEASON_1_START_TIMESTAMP) return 1;
  return Math.max(1, Math.floor((nowTs - MIDNIGHT_SEASON_1_START_TIMESTAMP) / WEEK_SECONDS) + 1);
}

function buildStatisticsRunsUrl(realm: string, name: string, characterId: number, seasonWeek: number): string {
  const href = `/characters/${DEFAULT_REGION}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}/stats/mythic-plus-runs?groupBy=dungeon&statSeason=${MIDNIGHT_SEASON_SLUG}`;
  const url = new URL(`${RAIDER_IO_INTERNAL_API_BASE}/statistics/get-data`);
  url.searchParams.set('season', MIDNIGHT_SEASON_SLUG);
  url.searchParams.set('type', 'runs-over-time');
  url.searchParams.set('minMythicLevel', '2');
  url.searchParams.set('maxMythicLevel', '99');
  url.searchParams.set('seasonWeekStart', String(seasonWeek));
  url.searchParams.set('seasonWeekEnd', String(seasonWeek));
  url.searchParams.set('href', href);
  url.searchParams.set('version', '4');
  url.searchParams.set('characterIds', String(characterId));
  url.searchParams.set('groupBy', 'dungeon');
  return url.toString();
}

async function fetchCharacterIdForStatistics(realm: string, name: string): Promise<number | null> {
  const response = await fetch(buildCharacterDetailsUrl(realm, name), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) return null;
  const payload = (await response.json()) as RaiderIoCharacterDetailsResponse;
  const rawId = Number(payload?.characterDetails?.character?.id ?? NaN);
  return Number.isInteger(rawId) && rawId > 0 ? rawId : null;
}

async function fetchStatisticsWeekTotal(realm: string, name: string, characterId: number, seasonWeek: number): Promise<number | null> {
  const response = await fetch(buildStatisticsRunsUrl(realm, name, characterId, seasonWeek), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as RaiderIoStatisticsResponse;
  const rows = payload.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row?.quantity ?? 0)), 0);
  return Number.isFinite(total) ? total : null;
}

export interface KeystoneRun {
  completedTs: number;       // unix seconds
  dungeonId: number | null;  // map_challenge_mode_id
  keystoneLevel: number | null;
}

export interface MythicPlusRunCounts {
  total: number | null;
  thisWeek: number | null;
  lastWeek: number | null;
  thisWeekKeyLevels: number[];
  /** All deduplicated runs seen across all profile lists, for persistent accumulation. */
  allRuns: KeystoneRun[];
}

function easternUtcOffsetMinutes(atUtc: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    hour: '2-digit',
  }).formatToParts(atUtc);

  const offsetLabel = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5';
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return -300;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes);
}

function getUsWeeklyResetTimestamp(): number {
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

  const weekdayToIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayIndex = weekdayToIndex[weekdayShort] ?? 2;
  const daysSinceTuesday = (dayIndex - 2 + 7) % 7;

  const localResetSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday, 11, 0, 0, 0));
  const offsetMinutes = easternUtcOffsetMinutes(localResetSeedUtc);
  let resetUtc = new Date(localResetSeedUtc.getTime() - offsetMinutes * 60 * 1000);

  if (resetUtc > now) {
    const previousWeekLocalSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday - 7, 11, 0, 0, 0));
    const previousWeekOffsetMinutes = easternUtcOffsetMinutes(previousWeekLocalSeedUtc);
    resetUtc = new Date(previousWeekLocalSeedUtc.getTime() - previousWeekOffsetMinutes * 60 * 1000);
  }

  return Math.floor(resetUtc.getTime() / 1000);
}

function listLength(list: RaiderIoKeystoneRun[] | undefined): number | null {
  return list && list.length > 0 ? list.length : null;
}

function extractKeyLevels(list: RaiderIoKeystoneRun[] | undefined): number[] {
  if (!list || list.length === 0) return [];
  return list
    .map((run) => Number(run.keystone_level ?? run.mythic_level ?? NaN))
    .filter((level) => Number.isInteger(level) && level > 0)
    .sort((a, b) => b - a);
}

function collectUniqueRunIds(response: RaiderIoCharacterProfileResponse): number | null {
  const uniqueIds = new Set<number>();
  const lists = [
    response.mythic_plus_best_runs,
    response.mythic_plus_alternate_runs,
    response.mythic_plus_recent_runs,
    response.mythic_plus_highest_level_runs,
    response.mythic_plus_weekly_highest_level_runs,
    response.mythic_plus_previous_weekly_highest_level_runs,
  ];

  for (const list of lists) {
    for (const run of list ?? []) {
      const runId = Number(run?.keystone_run_id ?? NaN);
      if (Number.isInteger(runId) && runId > 0) {
        uniqueIds.add(runId);
      }
    }
  }

  return uniqueIds.size > 0 ? uniqueIds.size : null;
}

function parseRunTimestamp(run: RaiderIoKeystoneRun): number | null {
  if (Number.isFinite(run.completed_at_timestamp) && Number(run.completed_at_timestamp) > 0) {
    return Math.floor(Number(run.completed_at_timestamp));
  }

  if (!run.completed_at) return null;
  const parsed = Date.parse(run.completed_at);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function deduplicateAndCollectRuns(response: RaiderIoCharacterProfileResponse): {
  allRuns: KeystoneRun[];
  thisWeek: number;
  lastWeek: number;
} {
  const resetTs = getUsWeeklyResetTimestamp();
  const previousResetTs = resetTs - (7 * 24 * 60 * 60);

  const candidateRuns = [
    ...(response.mythic_plus_recent_runs ?? []),
    ...(response.mythic_plus_weekly_highest_level_runs ?? []),
    ...(response.mythic_plus_previous_weekly_highest_level_runs ?? []),
    ...(response.mythic_plus_highest_level_runs ?? []),
    ...(response.mythic_plus_best_runs ?? []),
    ...(response.mythic_plus_alternate_runs ?? []),
  ];

  const timestampedRuns = candidateRuns
    .map((run) => ({ ts: parseRunTimestamp(run), run }))
    .filter((entry): entry is { ts: number; run: RaiderIoKeystoneRun } => entry.ts !== null)
    .sort((a, b) => a.ts - b.ts);

  // Match WoWAudit behavior: if two runs are within 60 seconds, treat as duplicate.
  const uniqueRuns: { ts: number; run: RaiderIoKeystoneRun }[] = [];
  for (const entry of timestampedRuns) {
    const isDuplicate = uniqueRuns.some((existing) => Math.abs(existing.ts - entry.ts) < 60);
    if (!isDuplicate) uniqueRuns.push(entry);
  }

  let thisWeek = 0;
  let lastWeek = 0;
  for (const { ts } of uniqueRuns) {
    if (ts >= resetTs) thisWeek += 1;
    else if (ts >= previousResetTs) lastWeek += 1;
  }

  const allRuns: KeystoneRun[] = uniqueRuns.map(({ ts, run }) => ({
    completedTs: ts,
    dungeonId: Number.isInteger(run.map_challenge_mode_id) ? (run.map_challenge_mode_id ?? null) : null,
    keystoneLevel: Number.isInteger(run.mythic_level ?? run.keystone_level)
      ? (run.mythic_level ?? run.keystone_level ?? null)
      : null,
  }));

  return { allRuns, thisWeek, lastWeek };
}

export async function getCharacterMythicPlusRunCounts(realmSlug: string, name: string): Promise<MythicPlusRunCounts> {
  const response = await fetch(buildCharacterProfileUrl(realmSlug, name), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) return { total: null, thisWeek: null, lastWeek: null, thisWeekKeyLevels: [], allRuns: [] };
    throw new Error(`Raider.IO character profile request failed (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as RaiderIoCharacterProfileResponse;
  const thisWeekKeyLevels = extractKeyLevels(payload.mythic_plus_weekly_highest_level_runs);
  const { allRuns, thisWeek, lastWeek } = deduplicateAndCollectRuns(payload);

  const mergedThisWeek = Math.max(
    thisWeek,
    listLength(payload.mythic_plus_weekly_highest_level_runs) ?? 0
  );

  return {
    total: collectUniqueRunIds(payload),
    thisWeek: mergedThisWeek > 0 ? mergedThisWeek : null,
    lastWeek: lastWeek > 0 ? lastWeek : listLength(payload.mythic_plus_previous_weekly_highest_level_runs),
    thisWeekKeyLevels,
    allRuns,
  };
}