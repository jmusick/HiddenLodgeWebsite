import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import {
  WclRateLimitError,
  applyWclRateLimitBackoff,
  clearWclBackoff,
  loadWclCharacterLookup,
  matchWclActorCharId,
  queryWcl,
  type WclCharacterLookup,
} from './wcl';
import {
  MIN_FIGHT_DURATION_MS,
  getDeathAnalysisNights,
  recencyWeight,
  requireAccessToken,
  type DeathAnalysisReportRow,
} from './death-analysis';

// Pull Score: a recency-weighted, per-pull performance score computed from WCL
// `table` data (ours), kept distinct from WCL's own all-time Parse (theirs).
// Reuses Death Analysis's canonical raid-night reports. See TODO.md "Pull
// Score & Parse Analysis" for the full plan. Mirrors refreshMechanicsAnalysis
// in mechanics-analysis.ts for the sync shape.

/**
 * WCL difficulty ids scored. Heroic only for now. When Mythic starts, add 5
 * (or switch to [5]) — because a Pull Score is relative *within one pull*,
 * Heroic and Mythic rows are safe to mix, and Heroic ages out on its own via
 * the recency half-life and the Death Analysis 60-day prune.
 */
export const PULL_SCORE_DIFFICULTIES = new Set([4]);
/** Fewer than this many pulls in a role is "too few to score", not a fallback to the WCL median (different scale). */
export const PULL_SCORE_MIN_PULLS = 5;

/** Fights per aliased GraphQL request within one report (table x2 + playerDetails each) — see the spike's point-cost measurement in TODO.md. */
const PULL_SCORE_FIGHT_BATCH_SIZE = 5;
const DEFAULT_MAX_OPS_PER_RUN = 3;
/** Small budget: per-pull `table` queries are heavier WCL load than anything else the site does. */
const REFRESH_TIME_BUDGET_MS = 4_000;
/** WCL computes rankings with a lag; don't hammer a report that has none yet. */
const RANKINGS_RETRY_HOURS = 1;
/** Stop trying rankings on reports old enough that WCL should have computed them by now. */
const RANKINGS_MAX_AGE_DAYS = 3;
/** Stays under D1's 100 bound-parameter limit per statement. */
const D1_PARAM_CHUNK = 90;

export type PullScoreRole = 'tank' | 'healer' | 'dps';

interface PullScoreCursor {
  reportCode: string;
  totalFights: number;
  syncedFights: number;
  rankingsSynced: boolean;
  syncedAt: number;
  /** Last time a rankings query actually ran — distinct from syncedAt, which every fights-sync write also bumps. */
  rankingsAttemptedAt: number;
}

interface PullScoreFightRow {
  id?: number;
  startTime?: number;
  endTime?: number;
  encounterID?: number;
  name?: string;
  difficulty?: number;
  kill?: boolean;
  fightPercentage?: number | null;
}

interface RankingCharacterEntry {
  id?: number;
  name?: string;
  server?: { name?: string } | null;
  bracketPercent?: number | null;
}

interface RankingFightEntry {
  fightID?: number;
  roles?: {
    tanks?: { characters?: RankingCharacterEntry[] };
    healers?: { characters?: RankingCharacterEntry[] };
    dps?: { characters?: RankingCharacterEntry[] };
  };
}

interface WclTablePlayerEntry {
  guid?: number;
  total?: number;
}

interface WclPlayerDetailEntry {
  guid?: number;
  name?: string;
  server?: string;
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function toPositiveInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function toInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isPullRole(value: unknown): value is PullScoreRole {
  return value === 'tank' || value === 'healer' || value === 'dps';
}

function extractTableEntries(value: unknown): WclTablePlayerEntry[] {
  const entries = (value as { data?: { entries?: unknown } } | undefined)?.data?.entries;
  return Array.isArray(entries) ? (entries as WclTablePlayerEntry[]) : [];
}

function extractPlayerDetails(value: unknown): {
  tanks?: WclPlayerDetailEntry[];
  healers?: WclPlayerDetailEntry[];
  dps?: WclPlayerDetailEntry[];
} {
  const details = (value as { data?: { playerDetails?: unknown } } | undefined)?.data?.playerDetails;
  return (details as { tanks?: WclPlayerDetailEntry[]; healers?: WclPlayerDetailEntry[]; dps?: WclPlayerDetailEntry[] } | undefined) ?? {};
}

async function loadCursors(db: D1Database, codes: string[]): Promise<Map<string, PullScoreCursor>> {
  const out = new Map<string, PullScoreCursor>();
  for (const codesChunk of chunk(codes, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(
        `SELECT report_code, total_fights, synced_fights, rankings_synced, synced_at, rankings_attempted_at
           FROM pull_score_reports
          WHERE report_code IN (${codesChunk.map(() => '?').join(', ')})`
      )
      .bind(...codesChunk)
      .all<Record<string, unknown>>();
    for (const row of result.results ?? []) {
      out.set(String(row.report_code), {
        reportCode: String(row.report_code),
        totalFights: toInt(row.total_fights),
        syncedFights: toInt(row.synced_fights),
        rankingsSynced: toInt(row.rankings_synced) === 1,
        syncedAt: toInt(row.synced_at),
        rankingsAttemptedAt: toInt(row.rankings_attempted_at),
      });
    }
  }
  return out;
}

function pendingPhase(
  report: DeathAnalysisReportRow,
  cursor: PullScoreCursor | undefined,
  nowUtc: number
): 'fights' | 'rankings' | null {
  if (!cursor || cursor.syncedAt < report.syncedAt) return 'fights';
  if (cursor.syncedFights < cursor.totalFights) return 'fights';
  if (!cursor.rankingsSynced) {
    // Every report gets one unconditional attempt, however old — by the time a
    // backfilled night's fights finish syncing (could be weeks later), WCL has
    // long since computed rankings if it ever would. Only a *retry* after an
    // empty first attempt is limited to recent nights, where "WCL is still
    // computing" (the actual lag) is a real possibility worth waiting out.
    if (cursor.rankingsAttemptedAt === 0) return 'rankings';
    const endedDaysAgo = (nowUtc - report.endUtc) / 86_400;
    const lastTriedHoursAgo = (nowUtc - cursor.rankingsAttemptedAt) / 3_600;
    if (endedDaysAgo < RANKINGS_MAX_AGE_DAYS && lastTriedHoursAgo > RANKINGS_RETRY_HOURS) return 'rankings';
  }
  return null;
}

async function syncReportFightsBatch(
  db: D1Database,
  accessToken: string,
  ownership: WclCharacterLookup,
  report: DeathAnalysisReportRow,
  cursor: PullScoreCursor | undefined
): Promise<void> {
  const metadata = await queryWcl<{
    reportData?: {
      report?: {
        startTime?: number;
        fights?: PullScoreFightRow[];
        masterData?: { actors?: Array<{ id?: number; name?: string; server?: string; gameID?: number }> };
      } | null;
    };
  }>(
    accessToken,
    `
      query PullScoreMetadata($code: String!) {
        reportData {
          report(code: $code) {
            startTime
            fights { id startTime endTime encounterID name difficulty kill fightPercentage }
            masterData { actors(type: "Player") { id name server gameID } }
          }
        }
      }
    `,
    { code: report.code }
  );
  const reportData = metadata?.reportData?.report;
  if (!reportData) throw new Error('Unable to load Warcraft Logs report metadata.');
  const reportStartMs = Number(reportData.startTime ?? 0);

  const qualifying = (reportData.fights ?? [])
    .filter((fight) => {
      const fightId = toPositiveInt(fight.id);
      const encounterId = toPositiveInt(fight.encounterID);
      const difficulty = toPositiveInt(fight.difficulty);
      const durationMs = Number(fight.endTime ?? 0) - Number(fight.startTime ?? 0);
      return fightId > 0 && encounterId > 0 && PULL_SCORE_DIFFICULTIES.has(difficulty) && durationMs >= MIN_FIGHT_DURATION_MS;
    })
    .sort((a, b) => toPositiveInt(a.id) - toPositiveInt(b.id));

  // A live log that grew since our last touch (or a report we've never synced) starts over.
  const startFresh = !cursor || cursor.syncedAt < report.syncedAt;
  const startIndex = startFresh ? 0 : Math.min(cursor!.syncedFights, qualifying.length);
  const batch = qualifying.slice(startIndex, startIndex + PULL_SCORE_FIGHT_BATCH_SIZE);

  const statements = [];
  if (startFresh) {
    statements.push(db.prepare('DELETE FROM pull_score_pulls WHERE report_code = ?').bind(report.code));
  }

  if (batch.length > 0) {
    const fields = batch
      .map((fight) => {
        const fightId = toPositiveInt(fight.id);
        return (
          `f${fightId}_dmg: table(dataType: DamageDone, fightIDs: [${fightId}])\n` +
          `        f${fightId}_heal: table(dataType: Healing, fightIDs: [${fightId}])\n` +
          `        f${fightId}_players: playerDetails(fightIDs: [${fightId}])`
        );
      })
      .join('\n        ');

    const batchData = await queryWcl<{ reportData?: { report?: Record<string, unknown> | null } }>(
      accessToken,
      `
        query PullScoreTables($code: String!) {
          reportData {
            report(code: $code) {
              ${fields}
            }
          }
        }
      `,
      { code: report.code }
    );
    const reportFields = batchData?.reportData?.report ?? {};

    for (const fight of batch) {
      const fightId = toPositiveInt(fight.id);
      statements.push(db.prepare('DELETE FROM pull_score_pulls WHERE report_code = ? AND fight_id = ?').bind(report.code, fightId));

      const durationSeconds = Math.max(0.001, (Number(fight.endTime ?? 0) - Number(fight.startTime ?? 0)) / 1000);
      const dmgByGuid = new Map<number, number>();
      for (const entry of extractTableEntries(reportFields[`f${fightId}_dmg`])) {
        dmgByGuid.set(toPositiveInt(entry.guid), Number(entry.total ?? 0) / durationSeconds);
      }
      const healByGuid = new Map<number, number>();
      for (const entry of extractTableEntries(reportFields[`f${fightId}_heal`])) {
        healByGuid.set(toPositiveInt(entry.guid), Number(entry.total ?? 0) / durationSeconds);
      }

      const players = extractPlayerDetails(reportFields[`f${fightId}_players`]);
      const rolePlayers: Array<{ role: PullScoreRole; player: WclPlayerDetailEntry }> = [
        ...(players.tanks ?? []).map((player) => ({ role: 'tank' as const, player })),
        ...(players.healers ?? []).map((player) => ({ role: 'healer' as const, player })),
        ...(players.dps ?? []).map((player) => ({ role: 'dps' as const, player })),
      ];

      // Tanks/DPS score on DPS, healers score on HPS — never compare across metrics.
      const amountsByRole: Record<PullScoreRole, number[]> = { tank: [], healer: [], dps: [] };
      const scopedPlayers: Array<{ guid: number; role: PullScoreRole; amount: number; player: WclPlayerDetailEntry }> = [];
      for (const { role, player } of rolePlayers) {
        const guid = toPositiveInt(player.guid);
        if (guid <= 0) continue;
        const amount = role === 'healer' ? healByGuid.get(guid) : dmgByGuid.get(guid);
        if (amount === undefined || !Number.isFinite(amount)) continue;
        amountsByRole[role].push(amount);
        scopedPlayers.push({ guid, role, amount, player });
      }

      const medianByRole: Record<PullScoreRole, number> = {
        tank: median(amountsByRole.tank),
        healer: median(amountsByRole.healer),
        dps: median(amountsByRole.dps),
      };
      const countByRole: Record<PullScoreRole, number> = {
        tank: amountsByRole.tank.length,
        healer: amountsByRole.healer.length,
        dps: amountsByRole.dps.length,
      };

      const isKill = fight.kill === true;
      const bossPercent = Number(fight.fightPercentage ?? 0);
      const fightEndUtc = Math.floor((reportStartMs + Number(fight.endTime ?? 0)) / 1000);
      const encounterId = toPositiveInt(fight.encounterID);
      const encounterName = (fight.name ?? '').trim();
      const difficulty = toPositiveInt(fight.difficulty);

      // Rows are only stored for matched roster characters; the role median above still includes pugs.
      for (const scoped of scopedPlayers) {
        const charId = matchWclActorCharId({ gameID: scoped.guid, name: scoped.player.name, server: scoped.player.server }, ownership);
        if (!charId) continue;
        const roleMedian = medianByRole[scoped.role];
        const pullScore = roleMedian > 0 ? Math.max(0, Math.min(100, (50 * scoped.amount) / roleMedian)) : 0;

        statements.push(
          db
            .prepare(
              `INSERT INTO pull_score_pulls (
                 report_code, fight_id, blizzard_char_id, encounter_id, encounter_name, difficulty,
                 is_kill, boss_percent, fight_end_utc, role, amount, role_median, role_count, pull_score, wcl_percent
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
            )
            .bind(
              report.code,
              fightId,
              charId,
              encounterId,
              encounterName,
              difficulty,
              isKill ? 1 : 0,
              bossPercent,
              fightEndUtc,
              scoped.role,
              scoped.amount,
              roleMedian,
              countByRole[scoped.role],
              pullScore
            )
        );
      }
    }
  }

  const syncedFights = startIndex + batch.length;
  const rankingsSynced = startFresh ? 0 : cursor?.rankingsSynced ? 1 : 0;
  const rankingsAttemptedAt = startFresh ? 0 : cursor?.rankingsAttemptedAt ?? 0;
  statements.push(
    db
      .prepare(
        `INSERT INTO pull_score_reports (report_code, total_fights, synced_fights, rankings_synced, synced_at, rankings_attempted_at)
         VALUES (?, ?, ?, ?, unixepoch(), ?)
         ON CONFLICT(report_code) DO UPDATE SET
           total_fights = excluded.total_fights,
           synced_fights = excluded.synced_fights,
           rankings_synced = excluded.rankings_synced,
           synced_at = excluded.synced_at,
           rankings_attempted_at = excluded.rankings_attempted_at`
      )
      .bind(report.code, qualifying.length, syncedFights, rankingsSynced, rankingsAttemptedAt)
  );

  await db.batch(statements);
}

async function syncReportRankings(
  db: D1Database,
  accessToken: string,
  ownership: WclCharacterLookup,
  report: DeathAnalysisReportRow
): Promise<void> {
  const killRowsResult = await db
    .prepare('SELECT DISTINCT fight_id FROM pull_score_pulls WHERE report_code = ? AND is_kill = 1')
    .bind(report.code)
    .all<{ fight_id: number }>();
  const killFightIds = (killRowsResult.results ?? []).map((row) => toPositiveInt(row.fight_id)).filter((id) => id > 0);

  if (killFightIds.length === 0) {
    await db
      .prepare('UPDATE pull_score_reports SET rankings_synced = 1, rankings_attempted_at = unixepoch() WHERE report_code = ?')
      .bind(report.code)
      .run();
    return;
  }

  const rankingsData = await queryWcl<{ reportData?: { report?: { rankings?: { data?: RankingFightEntry[] } } | null } }>(
    accessToken,
    `
      query PullScoreRankings($code: String!, $fightIDs: [Int]) {
        reportData {
          report(code: $code) {
            rankings(fightIDs: $fightIDs)
          }
        }
      }
    `,
    { code: report.code, fightIDs: killFightIds }
  );
  const rankingRows = rankingsData?.reportData?.report?.rankings?.data ?? [];

  const statements = [];
  let matchedAny = false;
  for (const entry of rankingRows) {
    const fightId = toPositiveInt(entry.fightID);
    if (fightId <= 0) continue;
    const roleGroups = [entry.roles?.tanks, entry.roles?.healers, entry.roles?.dps];
    for (const roleGroup of roleGroups) {
      for (const character of roleGroup?.characters ?? []) {
        const charId = matchWclActorCharId(
          { gameID: character.id, name: character.name, server: character.server?.name },
          ownership
        );
        if (!charId) continue;
        const bracketPercent = Number(character.bracketPercent ?? NaN);
        if (!Number.isFinite(bracketPercent)) continue;
        matchedAny = true;
        statements.push(
          db
            .prepare('UPDATE pull_score_pulls SET wcl_percent = ? WHERE report_code = ? AND fight_id = ? AND blizzard_char_id = ?')
            .bind(bracketPercent, report.code, fightId, charId)
        );
      }
    }
  }
  // WCL computes rankings with a lag — an empty result this soon after the
  // kill likely means "not ready yet", not "no data ever". Only rankings_synced
  // when we actually wrote something; otherwise leave it pending so
  // pendingPhase retries (up to RANKINGS_MAX_AGE_DAYS out).
  statements.push(
    db
      .prepare(
        `UPDATE pull_score_reports SET rankings_synced = ?, rankings_attempted_at = unixepoch() WHERE report_code = ?`
      )
      .bind(matchedAny ? 1 : 0, report.code)
  );
  await db.batch(statements);
}

export interface PullScoreRefreshResult {
  pendingReports: number;
  processed: number;
  failed: number;
  remaining: number;
  rateLimited: boolean;
  budgetExhausted: boolean;
}

/**
 * Syncs Pull Score rows for canonical Death Analysis reports (Heroic, >= 30s
 * pulls, kills and wipes). Each call advances at most a few fights/reports —
 * a long night finishes over several cron ticks via the pull_score_reports
 * cursor. Also prunes rows for reports Death Analysis no longer keeps or that
 * are no longer canonical for their night.
 */
export async function refreshPullScores(
  dbInput?: D1Database,
  options?: { maxOps?: number; budgetMs?: number }
): Promise<PullScoreRefreshResult> {
  const db = getDatabase(dbInput);
  const deadline = Date.now() + (options?.budgetMs ?? REFRESH_TIME_BUDGET_MS);
  const maxOps = Math.max(1, Math.floor(options?.maxOps ?? DEFAULT_MAX_OPS_PER_RUN));
  const nowUtc = Math.floor(Date.now() / 1000);

  const nights = await getDeathAnalysisNights(db);
  const canonical = nights
    .map((night) => night.canonical)
    .filter((report): report is DeathAnalysisReportRow => Boolean(report && report.bossPulls > 0));
  const canonicalCodes = canonical.map((report) => report.code);

  if (canonicalCodes.length > 0) {
    await db.batch([
      db
        .prepare(`DELETE FROM pull_score_pulls WHERE report_code NOT IN (${canonicalCodes.map(() => '?').join(', ')})`)
        .bind(...canonicalCodes),
      db
        .prepare(`DELETE FROM pull_score_reports WHERE report_code NOT IN (${canonicalCodes.map(() => '?').join(', ')})`)
        .bind(...canonicalCodes),
    ]);
  } else {
    await db.batch([db.prepare('DELETE FROM pull_score_pulls'), db.prepare('DELETE FROM pull_score_reports')]);
  }

  const cursors = await loadCursors(db, canonicalCodes);
  const pendingFights = canonical
    .filter((report) => pendingPhase(report, cursors.get(report.code), nowUtc) === 'fights')
    .sort((a, b) => b.startUtc - a.startUtc);
  const pendingRankings = canonical
    .filter((report) => pendingPhase(report, cursors.get(report.code), nowUtc) === 'rankings')
    .sort((a, b) => b.startUtc - a.startUtc);

  const result: PullScoreRefreshResult = {
    pendingReports: pendingFights.length + pendingRankings.length,
    processed: 0,
    failed: 0,
    remaining: 0,
    rateLimited: false,
    budgetExhausted: false,
  };
  if (result.pendingReports === 0) return result;

  const accessToken = await requireAccessToken(db);
  const ownership = await loadWclCharacterLookup(db);
  let ops = 0;

  try {
    for (const report of pendingFights) {
      if (Date.now() >= deadline || ops >= maxOps) {
        result.budgetExhausted = true;
        break;
      }
      await syncReportFightsBatch(db, accessToken, ownership, report, cursors.get(report.code));
      ops += 1;
      result.processed += 1;
    }
    if (!result.budgetExhausted) {
      for (const report of pendingRankings) {
        if (Date.now() >= deadline || ops >= maxOps) {
          result.budgetExhausted = true;
          break;
        }
        await syncReportRankings(db, accessToken, ownership, report);
        ops += 1;
        result.processed += 1;
      }
    }
  } catch (error) {
    if (error instanceof WclRateLimitError) {
      await applyWclRateLimitBackoff(db, error);
      result.rateLimited = true;
    } else {
      result.failed += 1;
      console.warn('[pull-scores] failed to sync', error instanceof Error ? error.message : String(error));
    }
  }

  if (!result.rateLimited) await clearWclBackoff(db);
  result.remaining = Math.max(0, result.pendingReports - result.processed);
  return result;
}

export interface PullScoreRow {
  reportCode: string;
  fightId: number;
  blizzardCharId: number;
  encounterId: number;
  encounterName: string;
  difficulty: number;
  isKill: boolean;
  bossPercent: number;
  fightEndUtc: number;
  role: PullScoreRole;
  /** DPS for tank/dps rows, HPS for healer rows. */
  amount: number;
  roleMedian: number;
  roleCount: number;
  pullScore: number;
  /** WCL bracketPercent; null on wipes (kills only). */
  wclPercent: number | null;
}

/**
 * Every Pull Score row for the current canonical reports (all raiders, all
 * roles). Callers filter/group as needed — see aggregatePullScoreRows and
 * getPullScoreSummary. Never reads rows for a report that isn't currently
 * canonical for its night (an officer override moves the row set).
 */
export async function getPullScoreRows(dbInput?: D1Database): Promise<PullScoreRow[]> {
  const db = getDatabase(dbInput);
  const nights = await getDeathAnalysisNights(db);
  const canonicalCodes = nights
    .map((night) => night.canonical)
    .filter((report): report is DeathAnalysisReportRow => Boolean(report && report.bossPulls > 0))
    .map((report) => report.code);
  if (canonicalCodes.length === 0) return [];

  const rows: PullScoreRow[] = [];
  for (const codes of chunk(canonicalCodes, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(
        `SELECT report_code, fight_id, blizzard_char_id, encounter_id, encounter_name, difficulty,
                is_kill, boss_percent, fight_end_utc, role, amount, role_median, role_count, pull_score, wcl_percent
           FROM pull_score_pulls
          WHERE report_code IN (${codes.map(() => '?').join(', ')})`
      )
      .bind(...codes)
      .all<Record<string, unknown>>();
    for (const row of result.results ?? []) {
      if (!isPullRole(row.role)) continue;
      rows.push({
        reportCode: String(row.report_code),
        fightId: toPositiveInt(row.fight_id),
        blizzardCharId: toPositiveInt(row.blizzard_char_id),
        encounterId: toPositiveInt(row.encounter_id),
        encounterName: String(row.encounter_name ?? ''),
        difficulty: toPositiveInt(row.difficulty),
        isKill: toInt(row.is_kill) === 1,
        bossPercent: Number(row.boss_percent ?? 0),
        fightEndUtc: toPositiveInt(row.fight_end_utc),
        role: row.role,
        amount: Number(row.amount ?? 0),
        roleMedian: Number(row.role_median ?? 0),
        roleCount: toPositiveInt(row.role_count),
        pullScore: Number(row.pull_score ?? 0),
        wclPercent: row.wcl_percent === null || row.wcl_percent === undefined ? null : Number(row.wcl_percent),
      });
    }
  }
  return rows;
}

function weightedPullScoreAverage(rows: PullScoreRow[], nowUtc: number): number | null {
  let scoreSum = 0;
  let weightSum = 0;
  for (const row of rows) {
    const weight = recencyWeight(row.fightEndUtc, nowUtc);
    scoreSum += row.pullScore * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? scoreSum / weightSum : null;
}

export interface PullScoreAggregate {
  pullScore: number | null;
  pulls: number;
  kills: number;
  wclParseKillAvg: number | null;
  status: 'ok' | 'too-few-pulls';
}

/** rows must already be filtered to one raider's pulls in one role. */
export function aggregatePullScoreRows(rows: PullScoreRow[], nowUtc: number = Math.floor(Date.now() / 1000)): PullScoreAggregate {
  const pulls = rows.length;
  let weightedWclSum = 0;
  let weightedWclWeightSum = 0;
  let kills = 0;
  for (const row of rows) {
    if (row.isKill) kills += 1;
    if (row.wclPercent !== null) {
      const weight = recencyWeight(row.fightEndUtc, nowUtc);
      weightedWclSum += row.wclPercent * weight;
      weightedWclWeightSum += weight;
    }
  }
  return {
    pullScore: pulls >= PULL_SCORE_MIN_PULLS ? weightedPullScoreAverage(rows, nowUtc) : null,
    pulls,
    kills,
    wclParseKillAvg: weightedWclWeightSum > 0 ? weightedWclSum / weightedWclWeightSum : null,
    status: pulls >= PULL_SCORE_MIN_PULLS ? 'ok' : 'too-few-pulls',
  };
}

export interface PullHistoryEntry extends PullScoreRow {
  wclLink: string;
}

/** Sorts newest first and adds the WCL report link. Pure — doesn't touch the DB, so callers who already have rows (e.g. from getPullScoreRows) can reuse them for several raiders without refetching. */
export function toPullHistoryEntries(rows: PullScoreRow[]): PullHistoryEntry[] {
  return [...rows]
    .sort((a, b) => b.fightEndUtc - a.fightEndUtc)
    .map((row) => ({
      ...row,
      wclLink: `https://www.warcraftlogs.com/reports/${row.reportCode}#fight=${row.fightId}&type=${row.role === 'healer' ? 'healing' : 'damage-done'}`,
    }));
}

/** One raider's pull history, newest first, for the profile panel and the parse-analysis expanded row. */
export async function getPullHistory(dbInput: D1Database | undefined, blizzardCharId: number): Promise<PullHistoryEntry[]> {
  const rows = (await getPullScoreRows(dbInput)).filter((row) => row.blizzardCharId === blizzardCharId);
  return toPullHistoryEntries(rows);
}

export interface PullScoreSummaryEntry {
  blizzardCharId: number;
  role: PullScoreRole;
  pullScore: number | null;
  pulls: number;
  kills: number;
  wclParseKillAvg: number | null;
  status: 'ok' | 'too-few-pulls';
  /** Weighted score using only the last 14 days of pulls, no minimum-pulls gate. */
  trendRecent: number | null;
  /** Weighted score using pulls from 14-60 days ago. */
  trendPrior: number | null;
}

const TREND_RECENT_WINDOW_DAYS = 14;

/**
 * Per-raider/role aggregates for the /parse-analysis page. Takes rows from
 * getPullScoreRows and the effective role (tank/healer/dps, officer override
 * included — the same role Raid Comp assigns) per character; the caller
 * builds that map from getBenchData() since pull-scores.ts doesn't depend on
 * bench.ts (bench.ts depends on this module for scoring, not the reverse).
 */
export function getPullScoreSummary(
  rows: PullScoreRow[],
  effectiveRoleByCharId: Map<number, PullScoreRole>,
  nowUtc: number = Math.floor(Date.now() / 1000)
): PullScoreSummaryEntry[] {
  const byChar = new Map<number, PullScoreRow[]>();
  for (const row of rows) {
    if (effectiveRoleByCharId.get(row.blizzardCharId) !== row.role) continue;
    const list = byChar.get(row.blizzardCharId) ?? [];
    list.push(row);
    byChar.set(row.blizzardCharId, list);
  }

  const entries: PullScoreSummaryEntry[] = [];
  for (const [blizzardCharId, charRows] of byChar) {
    const role = effectiveRoleByCharId.get(blizzardCharId);
    if (!role) continue;
    const aggregate = aggregatePullScoreRows(charRows, nowUtc);
    const recentRows = charRows.filter((row) => (nowUtc - row.fightEndUtc) / 86_400 <= TREND_RECENT_WINDOW_DAYS);
    const priorRows = charRows.filter((row) => (nowUtc - row.fightEndUtc) / 86_400 > TREND_RECENT_WINDOW_DAYS);
    entries.push({
      blizzardCharId,
      role,
      pullScore: aggregate.pullScore,
      pulls: aggregate.pulls,
      kills: aggregate.kills,
      wclParseKillAvg: aggregate.wclParseKillAvg,
      status: aggregate.status,
      trendRecent: weightedPullScoreAverage(recentRows, nowUtc),
      trendPrior: weightedPullScoreAverage(priorRows, nowUtc),
    });
  }
  return entries;
}
