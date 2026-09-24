import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import {
  WclRateLimitError,
  applyWclRateLimitBackoff,
  clearWclBackoff,
  fetchReportFightStats,
  getWclAccessToken,
  getWclAuthConfig,
  getWclBackoffUntil,
  loadWclCharacterLookup,
  queryWcl,
  type WclCharacterLookup,
  type WclFightRow,
} from './wcl';
import { easternWallClockToUtcSeconds } from './wow-reset';
import { isGuildOfficer } from './auth';
import { specDeathAdjustment } from './spec-death-rates';

export const DEATH_ANALYSIS_WINDOW_DAYS = 60;
/** A raid night 30 days old contributes half as much as a raid night today. */
export const DEATH_ANALYSIS_RECENCY_HALF_LIFE_DAYS = 30;
export const DEATH_ANALYSIS_RAID_NAME = 'The Venomous Abyss';
export const DEATH_ANALYSIS_MIN_PULLS = 10;
export const DEATH_ANALYSIS_MIN_REPORTS = 2;
const SIGNIFICANT_THRESHOLD = 0.25;

// WCL difficulty ids: 3 Normal, 4 Heroic, 5 Mythic.
const QUALIFYING_DIFFICULTIES = new Set([4, 5]);
// Sub-30s fights are usually an immediate wipe (bad pull, DC, accidental pull)
// rather than a real attempt; excluding them keeps pulls/deaths meaningful.
export const MIN_FIGHT_DURATION_MS = 30_000;
// Raid nights are Thu/Fri 9pm–midnight Eastern.
const RAID_WEEKDAYS_ET = new Set([4, 5]);
const RAID_START_HOUR_ET = 21;
const RAID_END_HOUR_ET = 24;
const MIN_WINDOW_OVERLAP_SECONDS = 30 * 60;

const WCL_GUILD_ID = 781707;
const REPORT_PAGE_SIZE = 50;
const REPORT_MAX_PAGES = 20;
const DEFAULT_MAX_REPORTS_PER_RUN = 3;
/**
 * No new report sync starts after this much of the run has elapsed; the rest
 * stay pending for the next tick. Checked between reports (a single report's
 * event paging can't be interrupted cleanly), so it leaves headroom under the
 * 30s cron timeout for the report already in flight. WCL requests are capped
 * individually in wcl.ts.
 */
const REFRESH_TIME_BUDGET_MS = 12_000;

const zoneEncountersCache = new Map<number, { ids: Set<number>; names: Map<number, string> }>();

const etDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface GuildReport {
  code: string;
  startUtc: number;
  endUtc: number;
  zoneId: number | null;
  zoneName: string;
}

interface InWindowReport extends GuildReport {
  nightKey: string;
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toPositiveInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function deathAnalysisCutoffUtc(nowUtc: number = nowInSeconds()): number {
  return nowUtc - DEATH_ANALYSIS_WINDOW_DAYS * 86400;
}

function isRaidZone(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/^the\s+/, '');
  return normalized === DEATH_ANALYSIS_RAID_NAME.toLowerCase().replace(/^the\s+/, '');
}

function etNightKey(epochSeconds: number): string {
  return etDateFormatter.format(new Date(epochSeconds * 1000));
}

function parseNightKey(nightKey: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nightKey);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function raidWindowForNight(nightKey: string): { startUtc: number; endUtc: number } | null {
  const parts = parseNightKey(nightKey);
  if (!parts) return null;
  return {
    startUtc: easternWallClockToUtcSeconds(parts.year, parts.month, parts.day, RAID_START_HOUR_ET),
    endUtc: easternWallClockToUtcSeconds(parts.year, parts.month, parts.day, RAID_END_HOUR_ET),
  };
}

function isRaidWeekday(nightKey: string): boolean {
  const parts = parseNightKey(nightKey);
  if (!parts) return false;
  return RAID_WEEKDAYS_ET.has(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay());
}

export function raidNightForReport(startUtc: number, endUtc: number): string | null {
  let best: { nightKey: string; overlap: number } | null = null;
  for (const nightKey of new Set([etNightKey(startUtc), etNightKey(endUtc)])) {
    if (!isRaidWeekday(nightKey)) continue;
    const window = raidWindowForNight(nightKey);
    if (!window) continue;
    const overlap = Math.min(endUtc, window.endUtc) - Math.max(startUtc, window.startUtc);
    if (overlap >= MIN_WINDOW_OVERLAP_SECONDS && (!best || overlap > best.overlap)) {
      best = { nightKey, overlap };
    }
  }
  return best?.nightKey ?? null;
}

export function listRaidNights(nowUtc: number = nowInSeconds()): string[] {
  const today = parseNightKey(etNightKey(nowUtc));
  if (!today) return [];
  const nights: string[] = [];
  for (let offset = 0; offset <= DEATH_ANALYSIS_WINDOW_DAYS; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day - offset));
    const nightKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    if (!isRaidWeekday(nightKey)) continue;
    const window = raidWindowForNight(nightKey);
    if (window && window.startUtc <= nowUtc) nights.push(nightKey);
  }
  return nights;
}

async function listGuildReportsSince(accessToken: string, sinceUtc: number): Promise<GuildReport[]> {
  const byCode = new Map<string, GuildReport>();
  for (let page = 1; page <= REPORT_MAX_PAGES; page += 1) {
    const payload = await queryWcl<{
      reportData?: {
        reports?: {
          data?: Array<{ code?: string; startTime?: number; endTime?: number; zone?: { id?: number; name?: string } | null }>;
        };
      };
    }>(
      accessToken,
      `
        query DeathAnalysisReports($guildID: Int!, $startTime: Float!, $endTime: Float!, $limit: Int!, $page: Int!) {
          reportData {
            reports(guildID: $guildID, startTime: $startTime, endTime: $endTime, limit: $limit, page: $page) {
              data {
                code
                startTime
                endTime
                zone { id name }
              }
            }
          }
        }
      `,
      {
        guildID: WCL_GUILD_ID,
        startTime: sinceUtc * 1000,
        endTime: (nowInSeconds() + 3600) * 1000,
        limit: REPORT_PAGE_SIZE,
        page,
      }
    );

    const rows = payload?.reportData?.reports?.data ?? [];
    for (const row of rows) {
      const code = (row.code ?? '').trim();
      const startUtc = Math.floor(Number(row.startTime ?? 0) / 1000);
      const endUtc = Math.floor(Number(row.endTime ?? 0) / 1000);
      if (!code || startUtc <= 0) continue;
      byCode.set(code, {
        code,
        startUtc,
        endUtc: endUtc > startUtc ? endUtc : startUtc,
        zoneId: toPositiveInt(row.zone?.id) || null,
        zoneName: (row.zone?.name ?? '').trim(),
      });
    }
    if (rows.length < REPORT_PAGE_SIZE) break;
  }
  return [...byCode.values()];
}

async function getZoneEncounters(accessToken: string, zoneId: number): Promise<{ ids: Set<number>; names: Map<number, string> }> {
  const cached = zoneEncountersCache.get(zoneId);
  if (cached) return cached;

  const payload = await queryWcl<{ worldData?: { zone?: { encounters?: Array<{ id?: number; name?: string }> } | null } }>(
    accessToken,
    `
      query DeathAnalysisZone($id: Int!) {
        worldData {
          zone(id: $id) {
            encounters { id name }
          }
        }
      }
    `,
    { id: zoneId }
  );

  const ids = new Set<number>();
  const names = new Map<number, string>();
  for (const row of payload?.worldData?.zone?.encounters ?? []) {
    const id = toPositiveInt(row.id);
    if (id <= 0) continue;
    ids.add(id);
    const name = (row.name ?? '').trim();
    if (name) names.set(id, name);
  }
  const result = { ids, names };
  if (ids.size > 0) zoneEncountersCache.set(zoneId, result);
  return result;
}

async function syncReport(
  db: D1Database,
  accessToken: string,
  ownership: WclCharacterLookup,
  report: InWindowReport,
  options?: { keepSyncedAt?: boolean }
): Promise<void> {
  if (!report.zoneId) throw new Error('Report has no zone.');
  const encounters = await getZoneEncounters(accessToken, report.zoneId);
  if (encounters.ids.size === 0) throw new Error(`Could not resolve encounters for zone ${report.zoneId}.`);

  const isQualifyingFight = (fight: WclFightRow) =>
    encounters.ids.has(toPositiveInt(fight.encounterID)) &&
    QUALIFYING_DIFFICULTIES.has(toPositiveInt(fight.difficulty)) &&
    Number(fight.endTime ?? 0) - Number(fight.startTime ?? 0) >= MIN_FIGHT_DURATION_MS;

  const details = await fetchReportFightStats(accessToken, report.code, ownership, isQualifyingFight);

  const statements = [
    db
      .prepare(
        `INSERT INTO death_analysis_reports (report_code, night_key, report_start_utc, report_end_utc, boss_pulls, boss_kills, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(report_code) DO UPDATE SET
           night_key = excluded.night_key,
           report_start_utc = excluded.report_start_utc,
           report_end_utc = excluded.report_end_utc,
           boss_pulls = excluded.boss_pulls,
           boss_kills = excluded.boss_kills,
           -- A spec backfill keeps synced_at: mechanics and Pull Scores re-sync any
           -- report whose synced_at moves, and nothing they read has changed.
           synced_at = CASE WHEN ? THEN death_analysis_reports.synced_at ELSE excluded.synced_at END`
      )
      .bind(
        report.code,
        report.nightKey,
        details.reportStartUtc ?? report.startUtc,
        details.reportEndUtc ?? report.endUtc,
        details.scopedFightCount,
        details.scopedKillCount,
        options?.keepSyncedAt ? 1 : 0
      ),
    db.prepare('DELETE FROM death_analysis_stats WHERE report_code = ?').bind(report.code),
    ...[...details.deathStatsByCharId.entries()]
      .filter(([, stats]) => stats.fightsPresent > 0 || stats.totalDeaths > 0)
      .map(([blizzardCharId, stats]) =>
        db
          .prepare(
            `INSERT INTO death_analysis_stats (
               report_code, blizzard_char_id, fights_present, total_deaths,
               first_death_count, second_death_count, third_death_count, fourth_death_count, spec_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            report.code,
            blizzardCharId,
            stats.fightsPresent,
            stats.totalDeaths,
            stats.firstDeathCount,
            stats.secondDeathCount,
            stats.thirdDeathCount,
            stats.fourthDeathCount,
            // 0 = synced but WCL gave no spec; NULL = synced before spec_id existed (backfill pending).
            details.specIdByCharId.get(blizzardCharId) ?? 0
          )
      ),
    db.prepare('DELETE FROM death_analysis_events WHERE report_code = ?').bind(report.code),
    ...details.deathEvents.map((event) =>
      db
        .prepare(
          `INSERT INTO death_analysis_events (
             report_code, fight_id, death_position, blizzard_char_id, encounter_id, encounter_name, death_offset_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          report.code,
          event.fightId,
          event.deathPosition,
          event.blizzardCharId,
          event.encounterId,
          encounters.names.get(event.encounterId) ?? '',
          event.deathOffsetMs
        )
    ),
  ];
  await db.batch(statements);
}

async function pruneOldRows(db: D1Database, cutoffUtc: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM death_analysis_stats
         WHERE report_code IN (SELECT report_code FROM death_analysis_reports WHERE report_end_utc < ?)`
      )
      .bind(cutoffUtc),
    db.prepare('DELETE FROM death_analysis_reports WHERE report_end_utc < ?').bind(cutoffUtc),
    db.prepare('DELETE FROM death_analysis_night_overrides WHERE night_key < ?').bind(etNightKey(cutoffUtc)),
  ]);
}

export async function requireAccessToken(db: D1Database): Promise<string> {
  const backoffUntil = await getWclBackoffUntil(db);
  if (backoffUntil && backoffUntil > nowInSeconds()) {
    throw new Error(`Warcraft Logs API backoff active until ${new Date(backoffUntil * 1000).toISOString()}.`);
  }
  const config = getWclAuthConfig();
  if (!config) throw new Error('WCL credentials are not configured.');
  const accessToken = await getWclAccessToken(config);
  if (!accessToken) throw new Error('Failed to get WCL access token.');
  return accessToken;
}

// Admins, plus guild officers (roster ranks 0-3), can pick the canonical log for a night.
export async function canManageLogMatching(
  dbInput: D1Database | undefined,
  user: { id: number } | null | undefined,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true;
  if (!user) return false;
  return isGuildOfficer(getDatabase(dbInput), user.id);
}

export async function setNightOverride(
  dbInput: D1Database | undefined,
  nightKey: string,
  reportCode: string | null,
  userId: number
): Promise<void> {
  const db = getDatabase(dbInput);
  if (!reportCode) {
    const previous = await db
      .prepare(
        `SELECT r.report_code, r.report_start_utc, r.report_end_utc
         FROM death_analysis_night_overrides o
         JOIN death_analysis_reports r ON r.report_code = o.report_code
         WHERE o.night_key = ?`
      )
      .bind(nightKey)
      .first<{ report_code: string; report_start_utc: number; report_end_utc: number }>();
    const statements = [db.prepare('DELETE FROM death_analysis_night_overrides WHERE night_key = ?').bind(nightKey)];
    const naturalNight = previous ? raidNightForReport(previous.report_start_utc, previous.report_end_utc) : null;
    if (previous && naturalNight) {
      statements.push(
        db.prepare('UPDATE death_analysis_reports SET night_key = ? WHERE report_code = ?').bind(naturalNight, previous.report_code)
      );
    }
    await db.batch(statements);
    return;
  }

  // Always re-pull from WCL so saving also refreshes a report synced before it finished.
  await syncDeathAnalysisReport(db, reportCode, nightKey);

  await db
    .prepare(
      `INSERT INTO death_analysis_night_overrides (night_key, report_code, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(night_key) DO UPDATE SET
         report_code = excluded.report_code,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(nightKey, reportCode, userId)
    .run();
}

export function isValidNightKey(nightKey: string): boolean {
  return listRaidNights().includes(nightKey);
}

export interface DeathAnalysisRefreshResult {
  inWindowReports: number;
  processed: number;
  failed: number;
  remaining: number;
  rateLimited: boolean;
  /** True when the run stopped early on REFRESH_TIME_BUDGET_MS; the rest carry over. */
  budgetExhausted: boolean;
}

export async function refreshDeathAnalysis(
  dbInput?: D1Database,
  options?: { maxReports?: number }
): Promise<DeathAnalysisRefreshResult> {
  const db = getDatabase(dbInput);
  const deadline = Date.now() + REFRESH_TIME_BUDGET_MS;
  const accessToken = await requireAccessToken(db);
  const maxReports = Math.max(1, Math.floor(options?.maxReports ?? DEFAULT_MAX_REPORTS_PER_RUN));
  const cutoffUtc = deathAnalysisCutoffUtc();

  await pruneOldRows(db, cutoffUtc);

  const inWindow: InWindowReport[] = [];
  for (const report of await listGuildReportsSince(accessToken, cutoffUtc)) {
    if (!isRaidZone(report.zoneName)) continue;
    const nightKey = raidNightForReport(report.startUtc, report.endUtc);
    if (nightKey) inWindow.push({ ...report, nightKey });
  }

  const seenResult = await db
    .prepare('SELECT report_code, night_key, synced_at FROM death_analysis_reports')
    .all<{ report_code: string; night_key: string; synced_at: number }>();
  const seen = new Map((seenResult.results ?? []).map((row) => [row.report_code, row]));
  // New reports, plus live-logged ones that kept growing after their last sync
  // (otherwise a report synced mid-raid stays frozen at the pulls it had then).
  // A re-sync keeps the stored night so manual overrides aren't undone.
  const pending = inWindow
    .flatMap((report) => {
      const existing = seen.get(report.code);
      if (!existing) return [report];
      if (report.endUtc > toPositiveInt(existing.synced_at)) return [{ ...report, nightKey: existing.night_key }];
      return [];
    })
    .sort((a, b) => b.startUtc - a.startUtc);

  // Already-synced reports with stats rows from before spec_id existed. Re-read
  // after new work, newest first, without bumping synced_at (see syncReport).
  const pendingCodes = new Set(pending.map((report) => report.code));
  const backfillResult = await db
    .prepare('SELECT DISTINCT report_code FROM death_analysis_stats WHERE spec_id IS NULL AND fights_present > 0')
    .all<{ report_code: string }>();
  const backfillCodes = new Set((backfillResult.results ?? []).map((row) => row.report_code));
  const backfill = inWindow
    .filter((report) => backfillCodes.has(report.code) && !pendingCodes.has(report.code) && seen.has(report.code))
    .map((report) => ({ ...report, nightKey: seen.get(report.code)!.night_key }))
    .sort((a, b) => b.startUtc - a.startUtc);

  const result: DeathAnalysisRefreshResult = {
    inWindowReports: inWindow.length,
    processed: 0,
    failed: 0,
    remaining: 0,
    rateLimited: false,
    budgetExhausted: false,
  };
  const work = [
    ...pending.map((report) => ({ report, keepSyncedAt: false })),
    ...backfill.map((report) => ({ report, keepSyncedAt: true })),
  ];
  if (work.length === 0) return result;

  const ownership = await loadWclCharacterLookup(db);
  for (const { report, keepSyncedAt } of work.slice(0, maxReports)) {
    if (Date.now() >= deadline) {
      result.budgetExhausted = true;
      break;
    }
    try {
      await syncReport(db, accessToken, ownership, report, { keepSyncedAt });
      result.processed += 1;
    } catch (error) {
      if (error instanceof WclRateLimitError) {
        await applyWclRateLimitBackoff(db, error);
        result.rateLimited = true;
        break;
      }
      result.failed += 1;
      console.warn('[death-analysis] failed to sync report', {
        reportCode: report.code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!result.rateLimited) await clearWclBackoff(db);
  result.remaining = Math.max(0, work.length - result.processed);
  return result;
}

export async function syncDeathAnalysisReport(dbInput: D1Database | undefined, reportCode: string, nightKey: string): Promise<void> {
  const db = getDatabase(dbInput);
  const accessToken = await requireAccessToken(db);

  const payload = await queryWcl<{
    reportData?: { report?: { startTime?: number; endTime?: number; zone?: { id?: number; name?: string } | null } | null };
  }>(
    accessToken,
    `
      query DeathAnalysisReport($code: String!) {
        reportData {
          report(code: $code) {
            startTime
            endTime
            zone { id name }
          }
        }
      }
    `,
    { code: reportCode }
  );

  const report = payload?.reportData?.report;
  if (!report) throw new Error('Report not found on Warcraft Logs.');
  const zoneName = (report.zone?.name ?? '').trim();
  if (!isRaidZone(zoneName)) throw new Error(`Report is not a ${DEATH_ANALYSIS_RAID_NAME} log.`);

  const ownership = await loadWclCharacterLookup(db);
  try {
    await syncReport(db, accessToken, ownership, {
      code: reportCode,
      startUtc: Math.floor(Number(report.startTime ?? 0) / 1000),
      endUtc: Math.floor(Number(report.endTime ?? 0) / 1000),
      zoneId: toPositiveInt(report.zone?.id) || null,
      zoneName,
      nightKey,
    });
  } catch (error) {
    if (error instanceof WclRateLimitError) await applyWclRateLimitBackoff(db, error);
    throw error;
  }
}

export interface DeathAnalysisReportRow {
  code: string;
  startUtc: number;
  endUtc: number;
  bossPulls: number;
  bossKills: number;
  syncedAt: number;
}

export interface DeathAnalysisNight {
  nightKey: string;
  canonical: DeathAnalysisReportRow | null;
  isOverride: boolean;
  overrideCode: string | null;
  reports: DeathAnalysisReportRow[];
}

export interface DeathAnalysisDeathLink {
  reportCode: string;
  nightKey: string | null;
  fightId: number;
  encounterName: string;
  /** 1-4; position within the pull. */
  deathPosition: number;
  deathOffsetMs: number;
}

export interface DeathAnalysisEntry {
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
  /**
   * weightedScore with each report's deaths divided by that report's spec
   * adjustment (see spec-death-rates.ts). Drives ranking, the above-average
   * flag, and Raid Comp's death percentile.
   */
  adjustedScore: number;
  /** Spec played in the most counted pulls, null if never seen. */
  specId: number | null;
  /** Effective divisor across all counted reports (weightedScore / adjustedScore); 1 = no adjustment. */
  specAdjustment: number;
  totalDeathRate: number;
  /** Relative to the guild's average adjustedScore. */
  percentAboveAverage: number | null;
  isSignificantlyAboveAverage: boolean;
  /** Individual counted deaths across the reports that fed this raider's stats, most recent first. */
  deathLinks: DeathAnalysisDeathLink[];
}

export interface DeathAnalysisSummary {
  cutoffUtc: number;
  minimumPulls: number;
  minimumReports: number;
  nights: DeathAnalysisNight[];
  includedNights: number;
  includedPulls: number;
  lastSyncedAt: number | null;
  qualifiedPlayers: number;
  averageWeightedScore: number | null;
  averageAdjustedScore: number | null;
  rankings: DeathAnalysisEntry[];
  /** Raiders seen in counted reports but under the pull/report minimum; unsorted, no average comparison. */
  belowMinimum: DeathAnalysisEntry[];
}

function pickCanonical(reports: DeathAnalysisReportRow[], overrideCode: string | null): DeathAnalysisReportRow | null {
  if (overrideCode) {
    return reports.find((report) => report.code === overrideCode) ?? null;
  }
  const withPulls = reports.filter((report) => report.bossPulls > 0);
  withPulls.sort((a, b) => b.bossPulls - a.bossPulls || a.startUtc - b.startUtc);
  return withPulls[0] ?? null;
}

export async function getDeathAnalysisNights(dbInput?: D1Database): Promise<DeathAnalysisNight[]> {
  const db = getDatabase(dbInput);
  const cutoffUtc = deathAnalysisCutoffUtc();
  const [reportsResult, overridesResult] = await db.batch([
    db
      .prepare(
        `SELECT report_code, night_key, report_start_utc, report_end_utc, boss_pulls, boss_kills, synced_at
         FROM death_analysis_reports
         WHERE report_end_utc >= ?`
      )
      .bind(cutoffUtc),
    db.prepare('SELECT night_key, report_code FROM death_analysis_night_overrides'),
  ]);

  const reportsByNight = new Map<string, DeathAnalysisReportRow[]>();
  for (const row of (reportsResult.results ?? []) as Array<Record<string, unknown>>) {
    const nightKey = String(row.night_key);
    const list = reportsByNight.get(nightKey) ?? [];
    list.push({
      code: String(row.report_code),
      startUtc: toPositiveInt(row.report_start_utc),
      endUtc: toPositiveInt(row.report_end_utc),
      bossPulls: toPositiveInt(row.boss_pulls),
      bossKills: toPositiveInt(row.boss_kills),
      syncedAt: toPositiveInt(row.synced_at),
    });
    reportsByNight.set(nightKey, list);
  }

  const overrideByNight = new Map<string, string>();
  for (const row of (overridesResult.results ?? []) as Array<Record<string, unknown>>) {
    overrideByNight.set(String(row.night_key), String(row.report_code));
  }

  return listRaidNights().map((nightKey) => {
    const reports = (reportsByNight.get(nightKey) ?? []).sort((a, b) => a.startUtc - b.startUtc);
    const overrideCode = overrideByNight.get(nightKey) ?? null;
    return {
      nightKey,
      canonical: pickCanonical(reports, overrideCode),
      isOverride: Boolean(overrideCode),
      overrideCode,
      reports,
    };
  });
}

export function recencyWeight(reportEndUtc: number, nowUtc: number): number {
  const ageDays = Math.max(0, nowUtc - reportEndUtc) / 86_400;
  return 0.5 ** (ageDays / DEATH_ANALYSIS_RECENCY_HALF_LIFE_DAYS);
}

/**
 * Picks one display identity per blizzard_char_id (characters > roster > raider
 * cache). Join on `identity_choice ... AND ic.rn = 1`.
 */
export const CHARACTER_IDENTITY_CTE = `WITH identities AS (
           SELECT blizzard_char_id, name, realm, class_name, COALESCE(last_synced, 0) AS priority_ts, 1 AS priority_order
           FROM characters WHERE blizzard_char_id IS NOT NULL
           UNION ALL
           SELECT blizzard_char_id, name, realm, class_name, COALESCE(updated_at, 0), 2 FROM roster_members_cache
           UNION ALL
           SELECT blizzard_char_id, name, realm, class_name, COALESCE(updated_at, 0), 3 FROM raider_metrics_cache
         ),
         identity_choice AS (
           SELECT blizzard_char_id, name, realm, class_name,
             ROW_NUMBER() OVER (PARTITION BY blizzard_char_id ORDER BY priority_order ASC, priority_ts DESC) AS rn
           FROM identities
         )`;

export async function getDeathAnalysisSummary(dbInput?: D1Database): Promise<DeathAnalysisSummary> {
  const db = getDatabase(dbInput);
  const scoringNowUtc = nowInSeconds();
  const nights = await getDeathAnalysisNights(db);
  const included = nights.filter((night) => night.canonical && night.canonical.bossPulls > 0);
  const canonicalCodes = included.map((night) => night.canonical!.code);

  const nightKeyByReportCode = new Map(included.map((night) => [night.canonical!.code, night.nightKey]));
  const reportEndByCode = new Map(included.map((night) => [night.canonical!.code, night.canonical!.endUtc]));

  const rankings: DeathAnalysisEntry[] = [];
  const linksByChar = new Map<number, DeathAnalysisDeathLink[]>();
  if (canonicalCodes.length > 0) {
    const placeholders = canonicalCodes.map(() => '?').join(', ');

    const eventsResult = await db
      .prepare(
        `SELECT report_code, fight_id, death_position, blizzard_char_id, encounter_name, death_offset_ms
         FROM death_analysis_events
         WHERE report_code IN (${placeholders})`
      )
      .bind(...canonicalCodes)
      .all<Record<string, unknown>>();
    for (const row of eventsResult.results ?? []) {
      const blizzardCharId = toPositiveInt(row.blizzard_char_id);
      if (blizzardCharId <= 0) continue;
      const reportCode = String(row.report_code);
      const list = linksByChar.get(blizzardCharId) ?? [];
      list.push({
        reportCode,
        nightKey: nightKeyByReportCode.get(reportCode) ?? null,
        fightId: toPositiveInt(row.fight_id),
        encounterName: String(row.encounter_name ?? ''),
        deathPosition: toPositiveInt(row.death_position),
        deathOffsetMs: toPositiveInt(row.death_offset_ms),
      });
      linksByChar.set(blizzardCharId, list);
    }
    for (const list of linksByChar.values()) {
      list.sort((a, b) => (b.nightKey ?? '').localeCompare(a.nightKey ?? '') || a.fightId - b.fightId || a.deathPosition - b.deathPosition);
    }

    const result = await db
      .prepare(
        `${CHARACTER_IDENTITY_CTE}
         SELECT
           s.blizzard_char_id,
           s.report_code,
           COALESCE(ic.name, 'Unknown') AS name,
           COALESCE(ic.realm, 'Unknown') AS realm,
           COALESCE(ic.class_name, 'Unknown') AS class_name,
           s.fights_present,
           s.total_deaths,
           s.first_death_count,
           s.second_death_count,
           s.third_death_count,
           s.fourth_death_count,
           -- Reports synced before spec_id existed fall back to the latest known spec.
           COALESCE(NULLIF(s.spec_id, 0), bmr.spec_id) AS spec_id
         FROM death_analysis_stats s
         LEFT JOIN identity_choice ic ON ic.blizzard_char_id = s.blizzard_char_id AND ic.rn = 1
         LEFT JOIN bench_mechanic_roles bmr ON bmr.blizzard_char_id = s.blizzard_char_id
         WHERE s.report_code IN (${placeholders})`
      )
      .bind(...canonicalCodes)
      .all<Record<string, unknown>>();

    const aggregates = new Map<
      number,
      {
        name: string;
        realm: string;
        className: string;
        reportCodes: Set<string>;
        fightsPresent: number;
        totalDeaths: number;
        firstDeathCount: number;
        secondDeathCount: number;
        thirdDeathCount: number;
        fourthDeathCount: number;
        weightedPulls: number;
        weightedDeaths: number;
        weightedDeathImpact: number;
        adjustedDeathImpact: number;
        pullsBySpec: Map<number, number>;
      }
    >();
    for (const row of result.results ?? []) {
      const blizzardCharId = toPositiveInt(row.blizzard_char_id);
      if (blizzardCharId <= 0) continue;

      const fightsPresent = toPositiveInt(row.fights_present);
      const totalDeaths = toPositiveInt(row.total_deaths);
      const firstDeathCount = toPositiveInt(row.first_death_count);
      const secondDeathCount = toPositiveInt(row.second_death_count);
      const thirdDeathCount = toPositiveInt(row.third_death_count);
      const fourthDeathCount = toPositiveInt(row.fourth_death_count);
      const reportCode = String(row.report_code);
      const weight = recencyWeight(reportEndByCode.get(reportCode) ?? scoringNowUtc, scoringNowUtc);
      const aggregate = aggregates.get(blizzardCharId) ?? {
        name: String(row.name),
        realm: String(row.realm),
        className: String(row.class_name),
        reportCodes: new Set<string>(),
        fightsPresent: 0,
        totalDeaths: 0,
        firstDeathCount: 0,
        secondDeathCount: 0,
        thirdDeathCount: 0,
        fourthDeathCount: 0,
        weightedPulls: 0,
        weightedDeaths: 0,
        weightedDeathImpact: 0,
        adjustedDeathImpact: 0,
        pullsBySpec: new Map<number, number>(),
      };
      const specId = toPositiveInt(row.spec_id) || null;
      const deathImpact = (firstDeathCount * 4 + secondDeathCount * 3 + thirdDeathCount * 2 + fourthDeathCount) * weight;
      aggregate.reportCodes.add(reportCode);
      aggregate.fightsPresent += fightsPresent;
      aggregate.totalDeaths += totalDeaths;
      aggregate.firstDeathCount += firstDeathCount;
      aggregate.secondDeathCount += secondDeathCount;
      aggregate.thirdDeathCount += thirdDeathCount;
      aggregate.fourthDeathCount += fourthDeathCount;
      aggregate.weightedPulls += fightsPresent * weight;
      aggregate.weightedDeaths += totalDeaths * weight;
      aggregate.weightedDeathImpact += deathImpact;
      aggregate.adjustedDeathImpact += deathImpact / specDeathAdjustment(specId, aggregate.className);
      if (specId) aggregate.pullsBySpec.set(specId, (aggregate.pullsBySpec.get(specId) ?? 0) + fightsPresent);
      aggregates.set(blizzardCharId, aggregate);
    }

    for (const [blizzardCharId, aggregate] of aggregates) {
      if (aggregate.fightsPresent <= 0 || aggregate.weightedPulls <= 0) continue;
      const topSpec = [...aggregate.pullsBySpec.entries()].sort((a, b) => b[1] - a[1])[0];
      rankings.push({
        blizzardCharId,
        name: aggregate.name,
        realm: aggregate.realm,
        className: aggregate.className,
        reportCount: aggregate.reportCodes.size,
        fightsPresent: aggregate.fightsPresent,
        totalDeaths: aggregate.totalDeaths,
        firstDeathCount: aggregate.firstDeathCount,
        secondDeathCount: aggregate.secondDeathCount,
        thirdDeathCount: aggregate.thirdDeathCount,
        fourthDeathCount: aggregate.fourthDeathCount,
        weightedScore: aggregate.weightedDeathImpact / aggregate.weightedPulls,
        adjustedScore: aggregate.adjustedDeathImpact / aggregate.weightedPulls,
        specId: topSpec?.[0] ?? null,
        specAdjustment:
          aggregate.adjustedDeathImpact > 0
            ? aggregate.weightedDeathImpact / aggregate.adjustedDeathImpact
            : specDeathAdjustment(topSpec?.[0] ?? null, aggregate.className),
        totalDeathRate: aggregate.weightedDeaths / aggregate.weightedPulls,
        percentAboveAverage: null,
        isSignificantlyAboveAverage: false,
        deathLinks: linksByChar.get(blizzardCharId) ?? [],
      });
    }
  }

  const meetsMinimum = (row: DeathAnalysisEntry) =>
    row.fightsPresent >= DEATH_ANALYSIS_MIN_PULLS && row.reportCount >= DEATH_ANALYSIS_MIN_REPORTS;
  const qualified = rankings.filter(meetsMinimum);
  const belowMinimum = rankings.filter((row) => !meetsMinimum(row));
  const average = (pick: (row: DeathAnalysisEntry) => number) =>
    qualified.length > 0 ? qualified.reduce((sum, row) => sum + pick(row), 0) / qualified.length : null;
  const averageWeightedScore = average((row) => row.weightedScore);
  const averageAdjustedScore = average((row) => row.adjustedScore);

  if (averageAdjustedScore !== null) {
    for (const row of qualified) {
      if (averageAdjustedScore > 0) {
        row.percentAboveAverage = ((row.adjustedScore - averageAdjustedScore) / averageAdjustedScore) * 100;
        row.isSignificantlyAboveAverage = row.percentAboveAverage > SIGNIFICANT_THRESHOLD * 100;
      } else {
        row.percentAboveAverage = row.adjustedScore > 0 ? 100 : 0;
        row.isSignificantlyAboveAverage = row.adjustedScore > 0;
      }
    }
  }

  qualified.sort(
    (a, b) =>
      b.adjustedScore - a.adjustedScore ||
      b.firstDeathCount - a.firstDeathCount ||
      b.totalDeaths - a.totalDeaths ||
      a.name.localeCompare(b.name)
  );

  const allSyncedAt = nights.flatMap((night) => night.reports.map((report) => report.syncedAt));
  return {
    cutoffUtc: deathAnalysisCutoffUtc(),
    minimumPulls: DEATH_ANALYSIS_MIN_PULLS,
    minimumReports: DEATH_ANALYSIS_MIN_REPORTS,
    nights,
    includedNights: included.length,
    includedPulls: included.reduce((sum, night) => sum + night.canonical!.bossPulls, 0),
    lastSyncedAt: allSyncedAt.length > 0 ? Math.max(...allSyncedAt) : null,
    qualifiedPlayers: qualified.length,
    averageWeightedScore,
    averageAdjustedScore,
    rankings: qualified,
    belowMinimum,
  };
}
