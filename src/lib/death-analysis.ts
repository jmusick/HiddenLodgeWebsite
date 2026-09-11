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

export const DEATH_ANALYSIS_WINDOW_DAYS = 90;
export const DEATH_ANALYSIS_RAID_NAME = 'The Venomous Abyss';
export const DEATH_ANALYSIS_MIN_PULLS = 20;
export const DEATH_ANALYSIS_MIN_REPORTS = 4;
const SIGNIFICANT_THRESHOLD = 0.25;

// WCL difficulty ids: 3 Normal, 4 Heroic, 5 Mythic.
const QUALIFYING_DIFFICULTIES = new Set([4, 5]);
// Raid nights are Thu/Fri 9pm–midnight Eastern.
const RAID_WEEKDAYS_ET = new Set([4, 5]);
const RAID_START_HOUR_ET = 21;
const RAID_END_HOUR_ET = 24;
const MIN_WINDOW_OVERLAP_SECONDS = 30 * 60;

const WCL_GUILD_ID = 781707;
const REPORT_PAGE_SIZE = 50;
const REPORT_MAX_PAGES = 20;
const DEFAULT_MAX_REPORTS_PER_RUN = 3;

const zoneEncounterIdsCache = new Map<number, Set<number>>();

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

async function getZoneEncounterIds(accessToken: string, zoneId: number): Promise<Set<number>> {
  const cached = zoneEncounterIdsCache.get(zoneId);
  if (cached) return cached;

  const payload = await queryWcl<{ worldData?: { zone?: { encounters?: Array<{ id?: number }> } | null } }>(
    accessToken,
    `
      query DeathAnalysisZone($id: Int!) {
        worldData {
          zone(id: $id) {
            encounters { id }
          }
        }
      }
    `,
    { id: zoneId }
  );

  const ids = new Set(
    (payload?.worldData?.zone?.encounters ?? []).map((row) => toPositiveInt(row.id)).filter((id) => id > 0)
  );
  if (ids.size > 0) zoneEncounterIdsCache.set(zoneId, ids);
  return ids;
}

async function syncReport(
  db: D1Database,
  accessToken: string,
  ownership: WclCharacterLookup,
  report: InWindowReport
): Promise<void> {
  if (!report.zoneId) throw new Error('Report has no zone.');
  const encounterIds = await getZoneEncounterIds(accessToken, report.zoneId);
  if (encounterIds.size === 0) throw new Error(`Could not resolve encounters for zone ${report.zoneId}.`);

  const isQualifyingFight = (fight: WclFightRow) =>
    encounterIds.has(toPositiveInt(fight.encounterID)) && QUALIFYING_DIFFICULTIES.has(toPositiveInt(fight.difficulty));

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
           synced_at = excluded.synced_at`
      )
      .bind(
        report.code,
        report.nightKey,
        details.reportStartUtc ?? report.startUtc,
        details.reportEndUtc ?? report.endUtc,
        details.scopedFightCount,
        details.scopedKillCount
      ),
    db.prepare('DELETE FROM death_analysis_stats WHERE report_code = ?').bind(report.code),
    ...[...details.deathStatsByCharId.entries()]
      .filter(([, stats]) => stats.fightsPresent > 0 || stats.totalDeaths > 0)
      .map(([blizzardCharId, stats]) =>
        db
          .prepare(
            `INSERT INTO death_analysis_stats (
               report_code, blizzard_char_id, fights_present, total_deaths,
               first_death_count, second_death_count, third_death_count, fourth_death_count
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            report.code,
            blizzardCharId,
            stats.fightsPresent,
            stats.totalDeaths,
            stats.firstDeathCount,
            stats.secondDeathCount,
            stats.thirdDeathCount,
            stats.fourthDeathCount
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

async function requireAccessToken(db: D1Database): Promise<string> {
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
  const row = await getDatabase(dbInput)
    .prepare(
      `SELECT 1 AS ok
       FROM characters c
       JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
       WHERE c.user_id = ? AND rmc.rank IN (0, 1, 2, 3)
       LIMIT 1`
    )
    .bind(user.id)
    .first<{ ok: number }>();
  return Boolean(row?.ok);
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

  const existing = await db
    .prepare('SELECT 1 AS found FROM death_analysis_reports WHERE report_code = ? LIMIT 1')
    .bind(reportCode)
    .first<{ found: number }>();
  if (existing) {
    await db.prepare('UPDATE death_analysis_reports SET night_key = ? WHERE report_code = ?').bind(nightKey, reportCode).run();
  } else {
    await syncDeathAnalysisReport(db, reportCode, nightKey);
  }

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
}

export async function refreshDeathAnalysis(
  dbInput?: D1Database,
  options?: { maxReports?: number }
): Promise<DeathAnalysisRefreshResult> {
  const db = getDatabase(dbInput);
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

  const seenResult = await db.prepare('SELECT report_code FROM death_analysis_reports').all<{ report_code: string }>();
  const seen = new Set((seenResult.results ?? []).map((row) => row.report_code));
  const pending = inWindow.filter((report) => !seen.has(report.code)).sort((a, b) => b.startUtc - a.startUtc);

  const result: DeathAnalysisRefreshResult = {
    inWindowReports: inWindow.length,
    processed: 0,
    failed: 0,
    remaining: 0,
    rateLimited: false,
  };
  if (pending.length === 0) return result;

  const ownership = await loadWclCharacterLookup(db);
  for (const report of pending.slice(0, maxReports)) {
    try {
      await syncReport(db, accessToken, ownership, report);
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
  result.remaining = Math.max(0, pending.length - result.processed);
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
  totalDeathRate: number;
  percentAboveAverage: number | null;
  isSignificantlyAboveAverage: boolean;
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
  rankings: DeathAnalysisEntry[];
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

function weightedDeathScore(entry: Pick<DeathAnalysisEntry, 'fightsPresent' | 'firstDeathCount' | 'secondDeathCount' | 'thirdDeathCount' | 'fourthDeathCount'>): number {
  if (entry.fightsPresent <= 0) return 0;
  return (
    (entry.firstDeathCount * 4 + entry.secondDeathCount * 3 + entry.thirdDeathCount * 2 + entry.fourthDeathCount) /
    entry.fightsPresent
  );
}

export async function getDeathAnalysisSummary(dbInput?: D1Database): Promise<DeathAnalysisSummary> {
  const db = getDatabase(dbInput);
  const nights = await getDeathAnalysisNights(db);
  const included = nights.filter((night) => night.canonical && night.canonical.bossPulls > 0);
  const canonicalCodes = included.map((night) => night.canonical!.code);

  const rankings: DeathAnalysisEntry[] = [];
  if (canonicalCodes.length > 0) {
    const placeholders = canonicalCodes.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `WITH identities AS (
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
         )
         SELECT
           s.blizzard_char_id,
           COALESCE(ic.name, 'Unknown') AS name,
           COALESCE(ic.realm, 'Unknown') AS realm,
           COALESCE(ic.class_name, 'Unknown') AS class_name,
           COUNT(*) AS report_count,
           SUM(s.fights_present) AS fights_present,
           SUM(s.total_deaths) AS total_deaths,
           SUM(s.first_death_count) AS first_death_count,
           SUM(s.second_death_count) AS second_death_count,
           SUM(s.third_death_count) AS third_death_count,
           SUM(s.fourth_death_count) AS fourth_death_count
         FROM death_analysis_stats s
         LEFT JOIN identity_choice ic ON ic.blizzard_char_id = s.blizzard_char_id AND ic.rn = 1
         WHERE s.report_code IN (${placeholders})
         GROUP BY s.blizzard_char_id, ic.name, ic.realm, ic.class_name`
      )
      .bind(...canonicalCodes)
      .all<Record<string, unknown>>();

    for (const row of result.results ?? []) {
      const entry: DeathAnalysisEntry = {
        blizzardCharId: toPositiveInt(row.blizzard_char_id),
        name: String(row.name),
        realm: String(row.realm),
        className: String(row.class_name),
        reportCount: toPositiveInt(row.report_count),
        fightsPresent: toPositiveInt(row.fights_present),
        totalDeaths: toPositiveInt(row.total_deaths),
        firstDeathCount: toPositiveInt(row.first_death_count),
        secondDeathCount: toPositiveInt(row.second_death_count),
        thirdDeathCount: toPositiveInt(row.third_death_count),
        fourthDeathCount: toPositiveInt(row.fourth_death_count),
        weightedScore: 0,
        totalDeathRate: 0,
        percentAboveAverage: null,
        isSignificantlyAboveAverage: false,
      };
      if (entry.blizzardCharId <= 0 || entry.fightsPresent <= 0) continue;
      entry.weightedScore = weightedDeathScore(entry);
      entry.totalDeathRate = entry.totalDeaths / entry.fightsPresent;
      rankings.push(entry);
    }
  }

  const qualified = rankings.filter(
    (row) => row.fightsPresent >= DEATH_ANALYSIS_MIN_PULLS && row.reportCount >= DEATH_ANALYSIS_MIN_REPORTS
  );
  const averageWeightedScore =
    qualified.length > 0 ? qualified.reduce((sum, row) => sum + row.weightedScore, 0) / qualified.length : null;

  if (averageWeightedScore !== null) {
    for (const row of qualified) {
      if (averageWeightedScore > 0) {
        row.percentAboveAverage = ((row.weightedScore - averageWeightedScore) / averageWeightedScore) * 100;
        row.isSignificantlyAboveAverage = row.percentAboveAverage > SIGNIFICANT_THRESHOLD * 100;
      } else {
        row.percentAboveAverage = row.weightedScore > 0 ? 100 : 0;
        row.isSignificantlyAboveAverage = row.weightedScore > 0;
      }
    }
  }

  qualified.sort(
    (a, b) =>
      b.weightedScore - a.weightedScore ||
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
    rankings: qualified,
  };
}
