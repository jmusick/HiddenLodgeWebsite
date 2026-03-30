import { getRaiderIoConfig } from './runtime-env';

const RAIDER_IO_BASE = 'https://raider.io/api/v1';
const DEFAULT_REGION = 'us';

interface RaiderIoKeystoneRun {
  keystone_run_id?: number;
  keystone_level?: number;
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

export interface MythicPlusRunCounts {
  total: number | null;
  thisWeek: number | null;
  lastWeek: number | null;
  thisWeekKeyLevels: number[];
}

function getUsWeeklyResetTimestamp(): number {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceTuesday = (day - 2 + 7) % 7;
  const resetDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceTuesday,
    15,
    0,
    0,
    0
  ));
  if (resetDate > now) resetDate.setUTCDate(resetDate.getUTCDate() - 7);
  return Math.floor(resetDate.getTime() / 1000);
}

function listLength(list: RaiderIoKeystoneRun[] | undefined): number | null {
  return list && list.length > 0 ? list.length : null;
}

function extractKeyLevels(list: RaiderIoKeystoneRun[] | undefined): number[] {
  if (!list || list.length === 0) return [];
  return list
    .map((run) => Number(run.keystone_level ?? NaN))
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

function estimateWeeklyRunCounts(response: RaiderIoCharacterProfileResponse): { thisWeek: number | null; lastWeek: number | null } {
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

  if (timestampedRuns.length === 0) {
    return { thisWeek: null, lastWeek: null };
  }

  // Match WoWAudit behavior: if two runs are within 60 seconds, treat as duplicate.
  const uniqueRunTimestamps: number[] = [];
  for (const entry of timestampedRuns) {
    const isDuplicate = uniqueRunTimestamps.some((existingTs) => Math.abs(existingTs - entry.ts) < 60);
    if (!isDuplicate) uniqueRunTimestamps.push(entry.ts);
  }

  let thisWeek = 0;
  let lastWeek = 0;
  for (const ts of uniqueRunTimestamps) {
    if (ts >= resetTs) {
      thisWeek += 1;
    } else if (ts >= previousResetTs) {
      lastWeek += 1;
    }
  }

  return { thisWeek, lastWeek };
}

export async function getCharacterMythicPlusRunCounts(realmSlug: string, name: string): Promise<MythicPlusRunCounts> {
  const response = await fetch(buildCharacterProfileUrl(realmSlug, name), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) return { total: null, thisWeek: null, lastWeek: null, thisWeekKeyLevels: [] };
    throw new Error(`Raider.IO character profile request failed (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as RaiderIoCharacterProfileResponse;
  const thisWeekKeyLevels = extractKeyLevels(payload.mythic_plus_weekly_highest_level_runs);
  const estimatedWeekly = estimateWeeklyRunCounts(payload);
  return {
    total: collectUniqueRunIds(payload),
    thisWeek: estimatedWeekly.thisWeek ?? listLength(payload.mythic_plus_weekly_highest_level_runs),
    lastWeek: estimatedWeekly.lastWeek ?? listLength(payload.mythic_plus_previous_weekly_highest_level_runs),
    thisWeekKeyLevels,
  };
}