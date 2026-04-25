import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { attendanceScoringStartUtc } from './attendance';

const EXCESSIVE_DEATH_MIN_PULLS = 5;
const EXCESSIVE_DEATH_SIGNIFICANT_THRESHOLD = 0.25;
// Main raids are Thu/Fri local, stored as Fri/Sat in UTC scheduling.
const MAIN_RAID_WEEKDAY_UTC = [5, 6] as const;

interface ExcessiveDeathOverviewRow {
  total_reports: number | null;
  synced_reports: number | null;
  total_boss_fights: number | null;
  synced_boss_fights: number | null;
  last_synced_at: number | null;
}

interface ExcessiveDeathAggregateRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  class_name: string;
  report_count: number | null;
  fights_present: number | null;
  total_deaths: number | null;
  first_death_count: number | null;
  second_death_count: number | null;
  third_death_count: number | null;
  fourth_death_count: number | null;
}

interface ExcessiveDeathIncludedLogRow {
  report_id: number;
  occurrence_start_utc: number;
  schedule_name: string | null;
  weekday_utc: number | null;
  report_code: string | null;
  report_start_utc: number | null;
  report_end_utc: number | null;
  total_boss_fights: number | null;
  total_boss_kills: number | null;
  total_boss_wipes: number | null;
  total_wipe_pulls: number | null;
  mapped_characters: number | null;
  death_stats_synced_at: number | null;
  merged_occurrences: number | null;
}

export interface ExcessiveDeathEntry {
  blizzardCharId: number;
  name: string;
  realm: string;
  className: string;
  reportCount: number;
  fightsPresent: number;
  totalDeaths: number;
  firstDeathCount: number;
  secondDeathCount: number;
  thirdDeathCount: number;
  fourthDeathCount: number;
  weightedScore: number;
  totalDeathRate: number;
  percentAboveAverage: number | null;
  isSignificantlyAboveAverage: boolean;
}

export interface ExcessiveDeathReviewSummary {
  startUtc: number;
  minimumPulls: number;
  totalReports: number;
  syncedReports: number;
  totalBossFights: number;
  syncedBossFights: number;
  lastSyncedAt: number | null;
  reviewedPlayers: number;
  qualifiedPlayers: number;
  averageWeightedScore: number | null;
  rankings: ExcessiveDeathEntry[];
  flagged: ExcessiveDeathEntry[];
  includedLogs: ExcessiveDeathIncludedLog[];
}

export interface ExcessiveDeathIncludedLog {
  reportId: number;
  occurrenceStartUtc: number;
  scheduleName: string;
  weekdayUtc: number | null;
  reportCode: string | null;
  reportUrl: string | null;
  reportStartUtc: number | null;
  reportEndUtc: number | null;
  totalBossFights: number;
  totalBossKills: number;
  totalBossWipes: number;
  totalWipePulls: number;
  mappedCharacters: number;
  deathStatsSyncedAt: number | null;
  isIncludedInCalculations: boolean;
  mergedOccurrences: number;
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function toPositiveInt(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function weightedDeathScore(row: {
  fightsPresent: number;
  firstDeathCount: number;
  secondDeathCount: number;
  thirdDeathCount: number;
  fourthDeathCount: number;
}): number {
  if (row.fightsPresent <= 0) return 0;

  const weightedTotal =
    row.firstDeathCount * 4 +
    row.secondDeathCount * 3 +
    row.thirdDeathCount * 2 +
    row.fourthDeathCount;

  return weightedTotal / row.fightsPresent;
}

export async function getExcessiveDeathReviewSummary(
  dbInput?: D1Database
): Promise<ExcessiveDeathReviewSummary> {
  const db = getDatabase(dbInput);
  const startUtc = attendanceScoringStartUtc();

  const [overviewResult, aggregatesResult, includedLogsResult] = await db.batch([
    db.prepare(
      `WITH scoped_reports AS (
         SELECT
           r.id,
           r.raid_ref_key,
           r.occurrence_start_utc,
           r.report_code,
           r.total_boss_fights,
           r.death_stats_synced_at
         FROM raid_attendance_reports r
         JOIN primary_raid_schedules prs ON prs.id = r.primary_schedule_id
         WHERE r.occurrence_start_utc >= ?
           AND r.raid_kind = 'primary'
           AND prs.weekday_utc IN (?, ?)
           AND (r.total_boss_kills + COALESCE(r.total_boss_wipes, 0)) > 0
       ),
       normalized_reports AS (
         SELECT
           id,
           raid_ref_key,
           occurrence_start_utc,
           CASE
             WHEN TRIM(COALESCE(raid_ref_key, '')) <> '' AND occurrence_start_utc > 0
               THEN LOWER(TRIM(raid_ref_key)) || '|' || date((occurrence_start_utc - 18000), 'unixepoch')
             WHEN TRIM(COALESCE(report_code, '')) <> '' THEN LOWER(TRIM(report_code))
             ELSE 'id:' || CAST(id AS TEXT)
           END AS dedupe_key,
           COALESCE(total_boss_fights, 0) AS total_boss_fights,
           death_stats_synced_at
         FROM scoped_reports
       ),
       deduped_reports AS (
         SELECT
           dedupe_key,
           MAX(total_boss_fights) AS total_boss_fights,
           MAX(death_stats_synced_at) AS death_stats_synced_at
         FROM normalized_reports
         GROUP BY dedupe_key
       )
       SELECT
         COUNT(*) AS total_reports,
         SUM(CASE WHEN death_stats_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced_reports,
         SUM(total_boss_fights) AS total_boss_fights,
         SUM(CASE WHEN death_stats_synced_at IS NOT NULL THEN total_boss_fights ELSE 0 END) AS synced_boss_fights,
         MAX(death_stats_synced_at) AS last_synced_at
       FROM deduped_reports`
    ).bind(startUtc, MAIN_RAID_WEEKDAY_UTC[0], MAIN_RAID_WEEKDAY_UTC[1]),
    db.prepare(
      `WITH scoped_reports AS (
         SELECT
           r.id,
           r.raid_ref_key,
           r.occurrence_start_utc,
           r.report_code,
           r.death_stats_synced_at
         FROM raid_attendance_reports r
         JOIN primary_raid_schedules prs ON prs.id = r.primary_schedule_id
         WHERE r.occurrence_start_utc >= ?
           AND r.raid_kind = 'primary'
           AND prs.weekday_utc IN (?, ?)
           AND (r.total_boss_kills + COALESCE(r.total_boss_wipes, 0)) > 0
       ),
       normalized_reports AS (
         SELECT
           id,
           raid_ref_key,
           occurrence_start_utc,
           CASE
             WHEN TRIM(COALESCE(raid_ref_key, '')) <> '' AND occurrence_start_utc > 0
               THEN LOWER(TRIM(raid_ref_key)) || '|' || date((occurrence_start_utc - 18000), 'unixepoch')
             WHEN TRIM(COALESCE(report_code, '')) <> '' THEN LOWER(TRIM(report_code))
             ELSE 'id:' || CAST(id AS TEXT)
           END AS dedupe_key,
           death_stats_synced_at
         FROM scoped_reports
       ),
       deduped_reports AS (
         SELECT
           dedupe_key,
           COALESCE(
             MIN(CASE WHEN death_stats_synced_at IS NOT NULL THEN id END),
             MIN(id)
           ) AS canonical_report_id,
           MAX(death_stats_synced_at) AS any_synced_at
         FROM normalized_reports
         GROUP BY dedupe_key
       ),
       synced_death_rows AS (
         SELECT
           dr.canonical_report_id AS report_id,
           ds.blizzard_char_id,
           ds.fights_present,
           ds.total_deaths,
           ds.first_death_count,
           ds.second_death_count,
           ds.third_death_count,
           ds.fourth_death_count
         FROM deduped_reports dr
         JOIN raid_attendance_death_stats ds ON ds.report_id = dr.canonical_report_id
         WHERE dr.any_synced_at IS NOT NULL
       ),
       identities AS (
         SELECT
           c.blizzard_char_id,
           c.name,
           c.realm,
           c.class_name,
           COALESCE(c.last_synced, 0) AS priority_ts,
           1 AS priority_order
         FROM characters c
         WHERE c.blizzard_char_id IS NOT NULL

         UNION ALL

         SELECT
           rmc.blizzard_char_id,
           rmc.name,
           rmc.realm,
           rmc.class_name,
           COALESCE(rmc.updated_at, 0) AS priority_ts,
           2 AS priority_order
         FROM roster_members_cache rmc

         UNION ALL

         SELECT
           rmc.blizzard_char_id,
           rmc.name,
           rmc.realm,
           rmc.class_name,
           COALESCE(rmc.updated_at, 0) AS priority_ts,
           3 AS priority_order
         FROM raider_metrics_cache rmc
       ),
       identity_choice AS (
         SELECT
           i.blizzard_char_id,
           i.name,
           i.realm,
           i.class_name,
           ROW_NUMBER() OVER (
             PARTITION BY i.blizzard_char_id
             ORDER BY i.priority_order ASC, i.priority_ts DESC
           ) AS rn
         FROM identities i
       )
       SELECT
         sd.blizzard_char_id,
         COALESCE(ic.name, 'Unknown') AS name,
         COALESCE(ic.realm, 'Unknown') AS realm,
         COALESCE(ic.class_name, 'Unknown') AS class_name,
         COUNT(sd.report_id) AS report_count,
         COALESCE(SUM(sd.fights_present), 0) AS fights_present,
         COALESCE(SUM(sd.total_deaths), 0) AS total_deaths,
         COALESCE(SUM(sd.first_death_count), 0) AS first_death_count,
         COALESCE(SUM(sd.second_death_count), 0) AS second_death_count,
         COALESCE(SUM(sd.third_death_count), 0) AS third_death_count,
         COALESCE(SUM(sd.fourth_death_count), 0) AS fourth_death_count
       FROM synced_death_rows sd
       LEFT JOIN identity_choice ic
         ON ic.blizzard_char_id = sd.blizzard_char_id
        AND ic.rn = 1
       GROUP BY sd.blizzard_char_id, ic.name, ic.realm, ic.class_name
       ORDER BY COALESCE(ic.name, 'Unknown') ASC`
    ).bind(startUtc, MAIN_RAID_WEEKDAY_UTC[0], MAIN_RAID_WEEKDAY_UTC[1]),
    db.prepare(
      `WITH scoped_reports AS (
         SELECT
           r.id,
           r.raid_ref_key,
           r.occurrence_start_utc,
           prs.name AS schedule_name,
           prs.weekday_utc,
           r.report_code,
           r.report_start_utc,
           r.report_end_utc,
           r.total_boss_fights,
           r.total_boss_kills,
           r.total_boss_wipes,
           r.total_wipe_pulls,
           r.death_stats_synced_at
         FROM raid_attendance_reports r
         JOIN primary_raid_schedules prs ON prs.id = r.primary_schedule_id
         WHERE r.occurrence_start_utc >= ?
           AND r.raid_kind = 'primary'
           AND prs.weekday_utc IN (?, ?)
           AND (r.total_boss_kills + COALESCE(r.total_boss_wipes, 0)) > 0
       ),
       normalized_reports AS (
         SELECT
           *,
           CASE
             WHEN TRIM(COALESCE(raid_ref_key, '')) <> '' AND occurrence_start_utc > 0
               THEN LOWER(TRIM(raid_ref_key)) || '|' || date((occurrence_start_utc - 18000), 'unixepoch')
             WHEN TRIM(COALESCE(report_code, '')) <> '' THEN LOWER(TRIM(report_code))
             ELSE 'id:' || CAST(id AS TEXT)
           END AS dedupe_key
         FROM scoped_reports
       ),
       deduped_reports AS (
         SELECT
           dedupe_key,
           COUNT(*) AS merged_occurrences,
           COALESCE(
             MIN(CASE WHEN death_stats_synced_at IS NOT NULL THEN id END),
             MIN(id)
           ) AS canonical_report_id,
           MAX(death_stats_synced_at) AS any_synced_at
         FROM normalized_reports
         GROUP BY dedupe_key
       )
       SELECT
         r.id AS report_id,
         r.occurrence_start_utc,
         r.schedule_name,
         r.weekday_utc,
         r.report_code,
         r.report_start_utc,
         r.report_end_utc,
         r.total_boss_fights,
         r.total_boss_kills,
         r.total_boss_wipes,
         r.total_wipe_pulls,
         (
           SELECT COUNT(DISTINCT ds.blizzard_char_id)
           FROM raid_attendance_death_stats ds
           WHERE ds.report_id = r.id
         ) AS mapped_characters,
         dr.any_synced_at AS death_stats_synced_at,
         dr.merged_occurrences
       FROM deduped_reports dr
       JOIN normalized_reports r ON r.id = dr.canonical_report_id
       ORDER BY r.occurrence_start_utc DESC
       LIMIT 120`
    ).bind(startUtc, MAIN_RAID_WEEKDAY_UTC[0], MAIN_RAID_WEEKDAY_UTC[1]),
  ]);

  const overview = (overviewResult.results?.[0] ?? null) as ExcessiveDeathOverviewRow | null;
  const aggregateRows = (aggregatesResult.results ?? []) as ExcessiveDeathAggregateRow[];
  const includedLogRows = (includedLogsResult.results ?? []) as ExcessiveDeathIncludedLogRow[];

  const rankings = aggregateRows
    .map((row) => {
      const fightsPresent = toPositiveInt(row.fights_present);
      const totalDeaths = toPositiveInt(row.total_deaths);
      const firstDeathCount = toPositiveInt(row.first_death_count);
      const secondDeathCount = toPositiveInt(row.second_death_count);
      const thirdDeathCount = toPositiveInt(row.third_death_count);
      const fourthDeathCount = toPositiveInt(row.fourth_death_count);
      const reportCount = toPositiveInt(row.report_count);
      const weightedScore = weightedDeathScore({
        fightsPresent,
        firstDeathCount,
        secondDeathCount,
        thirdDeathCount,
        fourthDeathCount,
      });

      return {
        blizzardCharId: toPositiveInt(row.blizzard_char_id),
        name: row.name,
        realm: row.realm,
        className: row.class_name,
        reportCount,
        fightsPresent,
        totalDeaths,
        firstDeathCount,
        secondDeathCount,
        thirdDeathCount,
        fourthDeathCount,
        weightedScore,
        totalDeathRate: fightsPresent > 0 ? totalDeaths / fightsPresent : 0,
        percentAboveAverage: null,
        isSignificantlyAboveAverage: false,
      } satisfies ExcessiveDeathEntry;
    })
    .filter((row) => row.blizzardCharId > 0 && row.fightsPresent > 0);

  const qualified = rankings.filter((row) => row.fightsPresent >= EXCESSIVE_DEATH_MIN_PULLS);
  const averageWeightedScore =
    qualified.length > 0
      ? qualified.reduce((sum, row) => sum + row.weightedScore, 0) / qualified.length
      : null;

  for (const row of rankings) {
    if (averageWeightedScore === null || row.fightsPresent < EXCESSIVE_DEATH_MIN_PULLS) {
      continue;
    }

    if (averageWeightedScore > 0) {
      row.percentAboveAverage = ((row.weightedScore - averageWeightedScore) / averageWeightedScore) * 100;
      row.isSignificantlyAboveAverage = row.percentAboveAverage > EXCESSIVE_DEATH_SIGNIFICANT_THRESHOLD * 100;
    } else {
      row.percentAboveAverage = row.weightedScore > 0 ? 100 : 0;
      row.isSignificantlyAboveAverage = row.weightedScore > 0;
    }
  }

  rankings.sort((left, right) => {
    if (right.weightedScore !== left.weightedScore) return right.weightedScore - left.weightedScore;
    if (right.firstDeathCount !== left.firstDeathCount) return right.firstDeathCount - left.firstDeathCount;
    if (right.totalDeaths !== left.totalDeaths) return right.totalDeaths - left.totalDeaths;
    return left.name.localeCompare(right.name);
  });

  const includedLogs: ExcessiveDeathIncludedLog[] = includedLogRows.map((row) => {
    const reportCode = (row.report_code ?? '').trim() || null;
    return {
      reportId: toPositiveInt(row.report_id),
      occurrenceStartUtc: toPositiveInt(row.occurrence_start_utc),
      scheduleName: (row.schedule_name ?? '').trim() || 'Unknown schedule',
      weekdayUtc: row.weekday_utc === null ? null : Math.floor(Number(row.weekday_utc)),
      reportCode,
      reportUrl: reportCode ? `https://www.warcraftlogs.com/reports/${reportCode}` : null,
      reportStartUtc: toPositiveInt(row.report_start_utc) || null,
      reportEndUtc: toPositiveInt(row.report_end_utc) || null,
      totalBossFights: toPositiveInt(row.total_boss_fights),
      totalBossKills: toPositiveInt(row.total_boss_kills),
      totalBossWipes: toPositiveInt(row.total_boss_wipes),
      totalWipePulls: toPositiveInt(row.total_wipe_pulls),
      mappedCharacters: toPositiveInt(row.mapped_characters),
      deathStatsSyncedAt: toPositiveInt(row.death_stats_synced_at) || null,
      isIncludedInCalculations: toPositiveInt(row.death_stats_synced_at) > 0,
      mergedOccurrences: Math.max(1, toPositiveInt(row.merged_occurrences)),
    };
  });

  return {
    startUtc,
    minimumPulls: EXCESSIVE_DEATH_MIN_PULLS,
    totalReports: toPositiveInt(overview?.total_reports),
    syncedReports: toPositiveInt(overview?.synced_reports),
    totalBossFights: toPositiveInt(overview?.total_boss_fights),
    syncedBossFights: toPositiveInt(overview?.synced_boss_fights),
    lastSyncedAt: toPositiveInt(overview?.last_synced_at) || null,
    reviewedPlayers: rankings.length,
    qualifiedPlayers: qualified.length,
    averageWeightedScore,
    rankings,
    flagged: rankings.filter((row) => row.isSignificantlyAboveAverage),
    includedLogs,
  };
}