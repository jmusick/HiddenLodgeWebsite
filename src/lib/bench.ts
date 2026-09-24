import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import {
  WclRateLimitError,
  applyWclRateLimitBackoff,
  clearWclBackoff,
  loadWclCharacterLookup,
  matchWclActorCharId,
  queryWcl,
  type WclFightRow,
} from './wcl';
import {
  getDeathAnalysisNights,
  getDeathAnalysisSummary,
  requireAccessToken,
  type DeathAnalysisEntry,
  type DeathAnalysisSummary,
} from './death-analysis';
import { ROLE_BY_SPEC_ID, type MechanicRole } from './mechanics-analysis';
import { computeGreatVaultScore } from './raiders';
import { getUsWeeklyResetTimestamp } from './wow-reset';
import { aggregatePullScoreRows, getPullScoreRows, type PullScoreRow } from './pull-scores';

// Bench analysis: Death Analysis + each raider's median WCL parse. Backs the
// officer-only scoring section of /raid-composition (Tools menu). Parses are cached
// in bench_parses; scoring inputs are configured on Raid Comp client-side,
// and Raid Comp (src/lib/raid-comp.ts) reuses this same priority order.

/** WCL difficulty the parses are pulled for (4 = Heroic), matching the guild rankings page. */
export const BENCH_PARSE_DIFFICULTY = 4;
/** Cached parses older than this are refetched by the cron. */
export const BENCH_PARSE_STALE_SECONDS = 6 * 60 * 60;
const WCL_SERVER_REGION = 'US';
/** Characters per GraphQL request (3 zoneRankings each). */
const PARSE_BATCH_SIZE = 10;
const DEFAULT_TIME_BUDGET_MS = 8_000;
/** Stays under D1's 100 bound-parameter limit per statement. */
const D1_PARAM_CHUNK = 90;
/** WCL difficulty ids: 4 Heroic, 5 Mythic — same scope as Death Analysis. */
const MECHANIC_ROLE_DIFFICULTIES = new Set([4, 5]);
/** Cached mechanic roles older than this are refetched (same cadence as parses). */
export const BENCH_MECHANIC_ROLE_STALE_SECONDS = 6 * 60 * 60;
const EVENT_MAX_PAGES = 20;

export type BenchRole = 'dps' | 'healer' | 'tank';
export const BENCH_ROLES: BenchRole[] = ['dps', 'healer', 'tank'];

export type BenchParseStatus = 'ok' | 'no-role-parse' | 'not-found' | 'pending';

export interface BenchRaider {
  blizzardCharId: number;
  name: string;
  realm: string;
  className: string;
  reportCount: number;
  fightsPresent: number;
  totalDeaths: number;
  weightedScore: number;
  /** Spec-adjusted death score (see DeathAnalysisEntry.adjustedScore); what Raid Comp's death percentile ranks on. */
  adjustedScore: number;
  totalDeathRate: number;
  role: BenchRole;
  autoRole: BenchRole;
  roleOverride: BenchRole | null;
  /** Melee/ranged (or tank/healer) from the latest raid night's WCL spec, null if never seen in a synced report. */
  mechanicRole: MechanicRole | null;
  /** Officer correction when the auto/WCL-derived melee-vs-ranged is wrong (e.g. an Enhancement Shaman auto-detected as ranged). */
  meleeRangedOverride: 'melee' | 'ranged' | null;
  /** Excluded from Raid Comp's "Regenerate" pool entirely (e.g. on vacation this raid). */
  isAbsent: boolean;
  /** Always included by "Regenerate", bumping a lower-priority same-role pick if needed. */
  isRaidLeader: boolean;
  /**
   * Raid Comp's scoring input: WCL's own bracketPercent (already
   * spec/boss/item-level-bracket normalized by WCL) for the raider's kills
   * in `role`, decay-weighted by recency instead of averaged flat over all
   * time the way wclParseMedian is (see pull-scores.ts). Only kills score —
   * WCL's public API has no percentile for wipes. Null unless
   * pullScoreStatus is 'ok'; never falls back to wclParseMedian, which is a
   * different (flat, all-time) scale.
   */
  pullScore: number | null;
  /** Every qualifying pull attended (kills and wipes) — attendance context; only kills feed pullScore. */
  pullScorePulls: number;
  pullScoreKills: number;
  pullScoreStatus: 'ok' | 'too-few-pulls';
  /** Median WCL parse for `role` (WCL medianPerformanceAverage) — the old flat all-time comparison point, still shown for reference. Null unless wclParseStatus is 'ok'. */
  wclParseMedian: number | null;
  wclParseBosses: number;
  wclParseStatus: BenchParseStatus;
  /** Current 0-100 Great Vault completion score, before guild-relative ranking. */
  vaultScore: number;
  /** Two-week rolling gem/enchant coverage percentage (current snapshot fallback), before guild-relative ranking. */
  preparednessScore: number;
  /** Upgrades completed since the weekly reset, based on the drop in missing upgrade ranks. */
  upgradesCompleted: number;
  /** Upgrade ranks still missing across equipped gear right now; 0 means fully upgraded. Null when not yet synced. */
  upgradesMissing: number | null;
}

export interface BenchFlags {
  meleeRangedOverride: 'melee' | 'ranged' | null;
  isAbsent: boolean;
  isRaidLeader: boolean;
}

export interface BenchData {
  summary: DeathAnalysisSummary;
  lastParseSyncAt: number | null;
  ranked: BenchRaider[];
  belowMinimum: BenchRaider[];
}

export interface BenchParseRefreshResult {
  candidates: number;
  processed: number;
  remaining: number;
  rateLimited: boolean;
  budgetExhausted: boolean;
}

interface ParseRow {
  blizzard_char_id: number;
  zone_id: number;
  wcl_found: number;
  dps_median: number | null;
  dps_bosses: number;
  healer_median: number | null;
  healer_bosses: number;
  tank_median: number | null;
  tank_bosses: number;
  synced_at: number;
}

interface BenchMetricsRow {
  blizzard_char_id: number;
  raid_progress_label: string | null;
  mythic_plus_vault_ilvl_1: number | null;
  mythic_plus_vault_ilvl_2: number | null;
  mythic_plus_vault_ilvl_3: number | null;
  world_vault_weekly_objectives: number | null;
  socketed_gems: number | null;
  total_sockets: number | null;
  enchanted_slots: number | null;
  enchantable_slots: number | null;
  avg_30d_socketed_gems: number | null;
  avg_30d_total_sockets: number | null;
  avg_30d_enchanted_slots: number | null;
  avg_30d_enchantable_slots: number | null;
  total_upgrades_missing: number | null;
}

interface WclZoneRankings {
  medianPerformanceAverage?: number | null;
  rankings?: Array<{ medianPercent?: number | null; totalKills?: number | null }>;
}

interface RoleParse {
  median: number | null;
  bosses: number;
}

let zoneIdCache: { reportCode: string; zoneId: number } | null = null;

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isBenchRole(value: unknown): value is BenchRole {
  return value === 'dps' || value === 'healer' || value === 'tank';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function roleParse(row: ParseRow, role: BenchRole): RoleParse {
  if (role === 'healer') return { median: row.healer_median, bosses: row.healer_bosses };
  if (role === 'tank') return { median: row.tank_median, bosses: row.tank_bosses };
  return { median: row.dps_median, bosses: row.dps_bosses };
}

function readRoleParse(rankings: WclZoneRankings | null | undefined): RoleParse {
  const bosses = (rankings?.rankings ?? []).filter(
    (row) => Number(row.totalKills ?? 0) > 0 && typeof row.medianPercent === 'number'
  ).length;
  const median = rankings?.medianPerformanceAverage;
  return { median: bosses > 0 && typeof median === 'number' && Number.isFinite(median) ? median : null, bosses };
}

/** Role with the most ranked bosses; ties go DPS, then healer, then tank. */
function pickAutoRole(row: ParseRow | undefined): BenchRole {
  if (!row) return 'dps';
  const rankedBosses = (role: BenchRole) => {
    const parse = roleParse(row, role);
    return parse.median === null ? 0 : parse.bosses;
  };
  return BENCH_ROLES.reduce((best, role) => (rankedBosses(role) > rankedBosses(best) ? role : best), 'dps' as BenchRole);
}

/** The raid zone comes from the newest counted Death Analysis report, so a new season needs no code change. */
async function resolveZoneId(db: D1Database, accessToken: string): Promise<number | null> {
  const nights = await getDeathAnalysisNights(db);
  const latest = nights.find((night) => night.canonical)?.canonical ?? null;
  if (!latest) return null;
  if (zoneIdCache?.reportCode === latest.code) return zoneIdCache.zoneId;

  const payload = await queryWcl<{ reportData?: { report?: { zone?: { id?: number } | null } | null } }>(
    accessToken,
    `
      query BenchZone($code: String!) {
        reportData {
          report(code: $code) { zone { id } }
        }
      }
    `,
    { code: latest.code }
  );
  const zoneId = Number(payload?.reportData?.report?.zone?.id ?? 0);
  if (!Number.isInteger(zoneId) || zoneId <= 0) return null;
  zoneIdCache = { reportCode: latest.code, zoneId };
  return zoneId;
}

/** Pages through a report's CombatantInfo events for the given fights. */
async function fetchCombatantInfoEvents(
  accessToken: string,
  reportCode: string,
  fights: WclFightRow[]
): Promise<Array<{ sourceID?: number; fight?: number; specID?: number; type?: string }>> {
  const fightIds = fights.map((fight) => Number(fight.id));
  let nextStart = Math.min(...fights.map((fight) => Number(fight.startTime ?? 0)));
  const end = Math.max(...fights.map((fight) => Number(fight.endTime ?? 0)));
  const all: Array<{ sourceID?: number; fight?: number; specID?: number; type?: string }> = [];

  for (let page = 0; page < EVENT_MAX_PAGES && nextStart <= end; page += 1) {
    const payload = await queryWcl<{
      reportData?: {
        report?: {
          events?: {
            data?: Array<{ sourceID?: number; fight?: number; specID?: number; type?: string }>;
            nextPageTimestamp?: number | null;
          };
        };
      };
    }>(
      accessToken,
      `
        query BenchCombatants($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!) {
          reportData {
            report(code: $code) {
              events(dataType: CombatantInfo, fightIDs: $fightIDs, startTime: $startTime, endTime: $endTime) {
                data
                nextPageTimestamp
              }
            }
          }
        }
      `,
      { code: reportCode, fightIDs: fightIds, startTime: nextStart, endTime: end }
    );
    if (!payload) throw new Error('Unable to load CombatantInfo events from Warcraft Logs.');

    all.push(...(payload.reportData?.report?.events?.data ?? []));
    const nextPage = Number(payload.reportData?.report?.events?.nextPageTimestamp ?? 0);
    if (!Number.isFinite(nextPage) || nextPage <= nextStart) break;
    nextStart = nextPage;
  }
  return all;
}

/**
 * Refreshes each raider's melee/ranged/tank/healer role from the latest
 * canonical raid night's WCL spec (CombatantInfo), same source as Mechanics
 * Analysis. Skipped if that report was already synced within
 * BENCH_MECHANIC_ROLE_STALE_SECONDS. A character absent from the latest
 * report (benched that night) keeps its last known role.
 */
export async function refreshBenchMechanicRoles(dbInput?: D1Database): Promise<{ synced: boolean; reportCode: string | null }> {
  const db = getDatabase(dbInput);
  const nights = await getDeathAnalysisNights(db);
  const latest = nights
    .map((night) => night.canonical)
    .filter((report): report is NonNullable<typeof report> => Boolean(report && report.bossPulls > 0))
    .sort((a, b) => b.startUtc - a.startUtc)[0];
  if (!latest) return { synced: false, reportCode: null };

  const syncedRow = await db
    .prepare('SELECT MAX(synced_at) AS synced_at FROM bench_mechanic_roles WHERE source_report_code = ?')
    .bind(latest.code)
    .first<{ synced_at: number | null }>();
  if ((syncedRow?.synced_at ?? 0) >= nowInSeconds() - BENCH_MECHANIC_ROLE_STALE_SECONDS) {
    return { synced: false, reportCode: latest.code };
  }

  const accessToken = await requireAccessToken(db);
  const metadata = await queryWcl<{
    reportData?: {
      report?: {
        fights?: WclFightRow[];
        masterData?: { actors?: Array<{ id?: number; name?: string; server?: string; gameID?: number }> };
      } | null;
    };
  }>(
    accessToken,
    `
      query BenchReportMetadata($code: String!) {
        reportData {
          report(code: $code) {
            fights { id startTime endTime encounterID difficulty kill }
            masterData { actors(type: "Player") { id name server gameID } }
          }
        }
      }
    `,
    { code: latest.code }
  );
  const report = metadata?.reportData?.report;
  if (!report) throw new Error('Unable to load Warcraft Logs report metadata.');

  const ownership = await loadWclCharacterLookup(db);
  const charIdByActorId = new Map<number, number>();
  for (const actor of report.masterData?.actors ?? []) {
    const actorId = Number(actor.id ?? 0);
    const charId = actorId > 0 ? matchWclActorCharId(actor, ownership) : null;
    if (actorId > 0 && charId) charIdByActorId.set(actorId, charId);
  }

  const fights = (report.fights ?? []).filter(
    (fight) => Number(fight.id) > 0 && MECHANIC_ROLE_DIFFICULTIES.has(Number(fight.difficulty ?? 0))
  );
  if (fights.length === 0) return { synced: false, reportCode: latest.code };

  const specByCharId = new Map<number, number>();
  for (const event of await fetchCombatantInfoEvents(accessToken, latest.code, fights)) {
    if (String(event.type ?? '').toLowerCase() !== 'combatantinfo') continue;
    const charId = charIdByActorId.get(Number(event.sourceID ?? 0));
    const specId = Number(event.specID ?? 0);
    if (charId && specId > 0) specByCharId.set(charId, specId);
  }

  if (specByCharId.size > 0) {
    await db.batch(
      [...specByCharId.entries()].map(([charId, specId]) =>
        db
          .prepare(
            `INSERT INTO bench_mechanic_roles (blizzard_char_id, spec_id, mechanic_role, source_report_code, synced_at)
             VALUES (?, ?, ?, ?, unixepoch())
             ON CONFLICT(blizzard_char_id) DO UPDATE SET
               spec_id = excluded.spec_id,
               mechanic_role = excluded.mechanic_role,
               source_report_code = excluded.source_report_code,
               synced_at = excluded.synced_at`
          )
          .bind(charId, specId, ROLE_BY_SPEC_ID.get(specId) ?? null, latest.code)
      )
    );
  }
  return { synced: true, reportCode: latest.code };
}

async function loadCharacterSlugs(
  db: D1Database,
  charIds: number[]
): Promise<Map<number, { name: string; realmSlug: string }>> {
  const out = new Map<number, { name: string; realmSlug: string }>();
  // The id list is bound three times, so chunk to a third of D1's parameter limit.
  for (const ids of chunk(charIds, Math.floor(D1_PARAM_CHUNK / 3))) {
    const placeholders = ids.map(() => '?').join(', ');
    // Same source priority as CHARACTER_IDENTITY_CTE: characters > roster > raider cache.
    const result = await db
      .prepare(
        `WITH slugs AS (
           SELECT blizzard_char_id, name, realm_slug, 1 AS priority_order FROM characters WHERE blizzard_char_id IN (${placeholders})
           UNION ALL
           SELECT blizzard_char_id, name, realm_slug, 2 FROM roster_members_cache WHERE blizzard_char_id IN (${placeholders})
           UNION ALL
           SELECT blizzard_char_id, name, realm_slug, 3 FROM raider_metrics_cache WHERE blizzard_char_id IN (${placeholders})
         ),
         ranked AS (
           SELECT blizzard_char_id, name, realm_slug,
             ROW_NUMBER() OVER (PARTITION BY blizzard_char_id ORDER BY priority_order ASC) AS rn
           FROM slugs
           WHERE COALESCE(name, '') <> '' AND COALESCE(realm_slug, '') <> ''
         )
         SELECT blizzard_char_id, name, realm_slug FROM ranked WHERE rn = 1`
      )
      .bind(...ids, ...ids, ...ids)
      .all<{ blizzard_char_id: number; name: string; realm_slug: string }>();
    for (const row of result.results ?? []) {
      out.set(Number(row.blizzard_char_id), { name: row.name, realmSlug: row.realm_slug });
    }
  }
  return out;
}

async function loadMechanicRoles(db: D1Database, charIds: number[]): Promise<Map<number, MechanicRole>> {
  const out = new Map<number, MechanicRole>();
  for (const ids of chunk(charIds, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(`SELECT blizzard_char_id, mechanic_role FROM bench_mechanic_roles WHERE blizzard_char_id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .all<{ blizzard_char_id: number; mechanic_role: string | null }>();
    for (const row of result.results ?? []) {
      const role = row.mechanic_role;
      if (role === 'tank' || role === 'healer' || role === 'melee' || role === 'ranged') {
        out.set(Number(row.blizzard_char_id), role);
      }
    }
  }
  return out;
}

async function loadBenchFlags(db: D1Database, charIds: number[]): Promise<Map<number, BenchFlags>> {
  const out = new Map<number, BenchFlags>();
  for (const ids of chunk(charIds, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(
        `SELECT blizzard_char_id, melee_ranged, is_absent, is_raid_leader FROM bench_flags WHERE blizzard_char_id IN (${ids.map(() => '?').join(', ')})`
      )
      .bind(...ids)
      .all<{ blizzard_char_id: number; melee_ranged: string | null; is_absent: number; is_raid_leader: number }>();
    for (const row of result.results ?? []) {
      out.set(Number(row.blizzard_char_id), {
        meleeRangedOverride: row.melee_ranged === 'melee' || row.melee_ranged === 'ranged' ? row.melee_ranged : null,
        isAbsent: Boolean(row.is_absent),
        isRaidLeader: Boolean(row.is_raid_leader),
      });
    }
  }
  return out;
}

async function loadParseRows(db: D1Database, charIds: number[]): Promise<Map<number, ParseRow>> {
  const out = new Map<number, ParseRow>();
  for (const ids of chunk(charIds, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(`SELECT * FROM bench_parses WHERE blizzard_char_id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .all<ParseRow>();
    for (const row of result.results ?? []) out.set(Number(row.blizzard_char_id), row);
  }
  return out;
}

function vaultRaidSlots(label: string | null): Array<number | null> {
  try {
    const options = (JSON.parse(label ?? '{}') as { vaultRaid?: { options?: unknown } }).vaultRaid?.options;
    if (!Array.isArray(options)) return [null, null, null];
    return [0, 1, 2].map((index) => {
      const value = Number(options[index]);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    });
  } catch {
    return [null, null, null];
  }
}

function preparednessScore(row: BenchMetricsRow): number {
  const socketed = row.avg_30d_socketed_gems ?? row.socketed_gems;
  const sockets = row.avg_30d_total_sockets ?? row.total_sockets;
  const enchanted = row.avg_30d_enchanted_slots ?? row.enchanted_slots;
  const enchantable = row.avg_30d_enchantable_slots ?? row.enchantable_slots;
  const total = (sockets ?? 0) + (enchantable ?? 0);
  if (socketed === null || sockets === null || enchanted === null || enchantable === null || total <= 0) return 0;
  return Math.max(0, Math.min(100, ((socketed + enchanted) / total) * 100));
}

async function loadWeeklyUpgradeProgress(db: D1Database, charIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const weekStart = getUsWeeklyResetTimestamp();
  const priorWeekStart = weekStart - 7 * 24 * 60 * 60;
  for (const ids of chunk(charIds, D1_PARAM_CHUNK)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `WITH latest_prior AS (
           SELECT blizzard_char_id, MAX(recorded_at) AS recorded_at
             FROM raider_progression_history
            WHERE blizzard_char_id IN (${placeholders})
              AND recorded_at >= ? AND recorded_at < ?
            GROUP BY blizzard_char_id
         )
         SELECT h.blizzard_char_id, h.total_upgrades_missing
           FROM raider_progression_history h
           JOIN latest_prior p ON p.blizzard_char_id = h.blizzard_char_id AND p.recorded_at = h.recorded_at`
      )
      .bind(...ids, priorWeekStart, weekStart)
      .all<{ blizzard_char_id: number; total_upgrades_missing: number | null }>();
    for (const row of result.results ?? []) {
      if (row.total_upgrades_missing !== null) out.set(Number(row.blizzard_char_id), Number(row.total_upgrades_missing));
    }
  }
  return out;
}

type BenchMetrics = Pick<BenchRaider, 'vaultScore' | 'preparednessScore' | 'upgradesCompleted' | 'upgradesMissing'>;

async function loadBenchMetrics(db: D1Database, charIds: number[]): Promise<Map<number, BenchMetrics>> {
  const priorWeekMissing = await loadWeeklyUpgradeProgress(db, charIds);
  const out = new Map<number, BenchMetrics>();
  for (const ids of chunk(charIds, D1_PARAM_CHUNK)) {
    const result = await db
      .prepare(
        `SELECT blizzard_char_id, raid_progress_label,
                mythic_plus_vault_ilvl_1, mythic_plus_vault_ilvl_2, mythic_plus_vault_ilvl_3, world_vault_weekly_objectives,
                socketed_gems, total_sockets, enchanted_slots, enchantable_slots,
                avg_30d_socketed_gems, avg_30d_total_sockets, avg_30d_enchanted_slots, avg_30d_enchantable_slots,
                total_upgrades_missing
           FROM raider_metrics_cache WHERE blizzard_char_id IN (${ids.map(() => '?').join(', ')})`
      )
      .bind(...ids)
      .all<BenchMetricsRow>();
    for (const row of result.results ?? []) {
      const priorMissing = priorWeekMissing.get(Number(row.blizzard_char_id));
      out.set(Number(row.blizzard_char_id), {
        vaultScore: computeGreatVaultScore(
          vaultRaidSlots(row.raid_progress_label),
          [row.mythic_plus_vault_ilvl_1, row.mythic_plus_vault_ilvl_2, row.mythic_plus_vault_ilvl_3],
          Math.max(0, row.world_vault_weekly_objectives ?? 0)
        ),
        preparednessScore: preparednessScore(row),
        upgradesCompleted:
          priorMissing === undefined || row.total_upgrades_missing === null
            ? 0
            : Math.max(0, priorMissing - Number(row.total_upgrades_missing)),
        upgradesMissing: row.total_upgrades_missing === null ? null : Number(row.total_upgrades_missing),
      });
    }
  }
  return out;
}

async function fetchParseBatch(
  accessToken: string,
  zoneId: number,
  batch: Array<{ charId: number; name: string; realmSlug: string }>
): Promise<Map<number, { found: boolean; dps: RoleParse; healer: RoleParse; tank: RoleParse }> | null> {
  const variableDefs: string[] = ['$zone: Int!', '$difficulty: Int!', '$region: String!'];
  const fields: string[] = [];
  const variables: Record<string, unknown> = { zone: zoneId, difficulty: BENCH_PARSE_DIFFICULTY, region: WCL_SERVER_REGION };
  const rankingArgs = 'zoneID: $zone, difficulty: $difficulty, byBracket: true';
  batch.forEach((entry, index) => {
    variableDefs.push(`$n${index}: String!`, `$s${index}: String!`);
    variables[`n${index}`] = entry.name;
    variables[`s${index}`] = entry.realmSlug;
    fields.push(`
      c${index}: character(name: $n${index}, serverSlug: $s${index}, serverRegion: $region) {
        dps: zoneRankings(${rankingArgs}, metric: dps, role: DPS)
        healer: zoneRankings(${rankingArgs}, metric: hps, role: Healer)
        tank: zoneRankings(${rankingArgs}, metric: dps, role: Tank)
      }`);
  });

  const payload = await queryWcl<{
    characterData?: Record<string, { dps?: WclZoneRankings; healer?: WclZoneRankings; tank?: WclZoneRankings } | null>;
  }>(accessToken, `query BenchParses(${variableDefs.join(', ')}) { characterData { ${fields.join('\n')} } }`, variables);
  if (!payload?.characterData) return null;

  const out = new Map<number, { found: boolean; dps: RoleParse; healer: RoleParse; tank: RoleParse }>();
  batch.forEach((entry, index) => {
    const character = payload.characterData?.[`c${index}`] ?? null;
    out.set(entry.charId, {
      found: character !== null,
      dps: readRoleParse(character?.dps),
      healer: readRoleParse(character?.healer),
      tank: readRoleParse(character?.tank),
    });
  });
  return out;
}

/** Everyone Death Analysis saw in a counted report, qualified or not. */
function benchCandidates(summary: DeathAnalysisSummary): DeathAnalysisEntry[] {
  return [...summary.rankings, ...summary.belowMinimum];
}

/**
 * Refetches parses that are missing, stale, or from a previous raid zone
 * (`force` refetches everyone). Stops starting new batches once the time
 * budget is spent; the rest carry over to the next run.
 */
export async function refreshBenchParses(
  dbInput?: D1Database,
  options?: { force?: boolean; budgetMs?: number }
): Promise<BenchParseRefreshResult> {
  const db = getDatabase(dbInput);
  const deadline = Date.now() + (options?.budgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const result: BenchParseRefreshResult = {
    candidates: 0,
    processed: 0,
    remaining: 0,
    rateLimited: false,
    budgetExhausted: false,
  };

  const summary = await getDeathAnalysisSummary(db);
  const charIds = benchCandidates(summary).map((entry) => entry.blizzardCharId);
  result.candidates = charIds.length;
  if (charIds.length === 0) return result;

  const refreshMechanicRolesBestEffort = async () => {
    // Suggested Raid Comp's melee/ranged classification must keep refreshing
    // even if every parse is already current.
    try {
      await refreshBenchMechanicRoles(db);
    } catch (error) {
      console.warn('[bench] failed to refresh mechanic roles', error);
    }
  };

  const [slugs, existing] = await Promise.all([loadCharacterSlugs(db, charIds), loadParseRows(db, charIds)]);
  const staleBefore = nowInSeconds() - BENCH_PARSE_STALE_SECONDS;
  // Stale rows are refetched every BENCH_PARSE_STALE_SECONDS, so a new raid
  // zone (new season) replaces everyone's parses within that window.
  const pending = charIds
    .filter((charId) => slugs.has(charId))
    .filter((charId) => options?.force || (existing.get(charId)?.synced_at ?? 0) < staleBefore)
    // Never-fetched characters first, then oldest.
    .sort((a, b) => (existing.get(a)?.synced_at ?? 0) - (existing.get(b)?.synced_at ?? 0))
    .map((charId) => ({ charId, ...slugs.get(charId)! }));
  result.remaining = pending.length;
  if (pending.length === 0) {
    await refreshMechanicRolesBestEffort();
    return result;
  }

  const accessToken = await requireAccessToken(db);
  const zoneId = await resolveZoneId(db, accessToken);
  if (!zoneId) throw new Error('Could not resolve the raid zone from Death Analysis reports.');

  for (const batch of chunk(pending, PARSE_BATCH_SIZE)) {
    if (Date.now() >= deadline) {
      result.budgetExhausted = true;
      break;
    }
    try {
      const parses = await fetchParseBatch(accessToken, zoneId, batch);
      if (!parses) throw new Error('Warcraft Logs returned no character data.');
      await db.batch(
        [...parses.entries()].map(([charId, parse]) =>
          db
            .prepare(
              `INSERT INTO bench_parses (
                 blizzard_char_id, zone_id, difficulty, wcl_found,
                 dps_median, dps_bosses, healer_median, healer_bosses, tank_median, tank_bosses, synced_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
               ON CONFLICT(blizzard_char_id) DO UPDATE SET
                 zone_id = excluded.zone_id,
                 difficulty = excluded.difficulty,
                 wcl_found = excluded.wcl_found,
                 dps_median = excluded.dps_median,
                 dps_bosses = excluded.dps_bosses,
                 healer_median = excluded.healer_median,
                 healer_bosses = excluded.healer_bosses,
                 tank_median = excluded.tank_median,
                 tank_bosses = excluded.tank_bosses,
                 synced_at = excluded.synced_at`
            )
            .bind(
              charId,
              zoneId,
              BENCH_PARSE_DIFFICULTY,
              parse.found ? 1 : 0,
              parse.dps.median,
              parse.dps.bosses,
              parse.healer.median,
              parse.healer.bosses,
              parse.tank.median,
              parse.tank.bosses
            )
        )
      );
      result.processed += batch.length;
    } catch (error) {
      if (error instanceof WclRateLimitError) {
        await applyWclRateLimitBackoff(db, error);
        result.rateLimited = true;
        break;
      }
      console.warn('[bench] failed to fetch parse batch', {
        characters: batch.map((entry) => entry.name),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!result.rateLimited) await clearWclBackoff(db);
  result.remaining = Math.max(0, pending.length - result.processed);

  await refreshMechanicRolesBestEffort();

  return result;
}

export async function getBenchData(dbInput?: D1Database): Promise<BenchData> {
  const db = getDatabase(dbInput);
  const summary = await getDeathAnalysisSummary(db);
  const charIds = benchCandidates(summary).map((entry) => entry.blizzardCharId);

  const [parseRows, overrideResult, mechanicRoles, benchFlags, metrics, pullScoreRows] = await Promise.all([
    loadParseRows(db, charIds),
    db.prepare('SELECT blizzard_char_id, role FROM bench_role_overrides').all<{ blizzard_char_id: number; role: string }>(),
    loadMechanicRoles(db, charIds),
    loadBenchFlags(db, charIds),
    loadBenchMetrics(db, charIds),
    getPullScoreRows(db),
  ]);
  const overrides = new Map<number, BenchRole>();
  for (const row of overrideResult.results ?? []) {
    if (isBenchRole(row.role)) overrides.set(Number(row.blizzard_char_id), row.role);
  }
  const noFlags: BenchFlags = { meleeRangedOverride: null, isAbsent: false, isRaidLeader: false };
  const pullScoreRowsByChar = new Map<number, PullScoreRow[]>();
  for (const row of pullScoreRows) {
    const list = pullScoreRowsByChar.get(row.blizzardCharId) ?? [];
    list.push(row);
    pullScoreRowsByChar.set(row.blizzardCharId, list);
  }

  const toRaider = (entry: DeathAnalysisEntry): BenchRaider => {
    const row = parseRows.get(entry.blizzardCharId);
    const autoRole = pickAutoRole(row);
    const roleOverride = overrides.get(entry.blizzardCharId) ?? null;
    const role = roleOverride ?? autoRole;
    const parse = row ? roleParse(row, role) : null;
    const wclParseStatus: BenchParseStatus = !row ? 'pending' : !row.wcl_found ? 'not-found' : parse?.median == null ? 'no-role-parse' : 'ok';
    const flags = benchFlags.get(entry.blizzardCharId) ?? noFlags;
    const scores = metrics.get(entry.blizzardCharId) ?? { vaultScore: 0, preparednessScore: 0, upgradesCompleted: 0, upgradesMissing: null };
    const roleRows = (pullScoreRowsByChar.get(entry.blizzardCharId) ?? []).filter((pullRow) => pullRow.role === role);
    const pullScore = aggregatePullScoreRows(roleRows);
    return {
      blizzardCharId: entry.blizzardCharId,
      name: entry.name,
      realm: entry.realm,
      className: entry.className,
      reportCount: entry.reportCount,
      fightsPresent: entry.fightsPresent,
      totalDeaths: entry.totalDeaths,
      weightedScore: entry.weightedScore,
      adjustedScore: entry.adjustedScore,
      totalDeathRate: entry.totalDeathRate,
      role,
      autoRole,
      roleOverride,
      mechanicRole: mechanicRoles.get(entry.blizzardCharId) ?? null,
      meleeRangedOverride: flags.meleeRangedOverride,
      isAbsent: flags.isAbsent,
      isRaidLeader: flags.isRaidLeader,
      pullScore: pullScore.pullScore,
      pullScorePulls: pullScore.pulls,
      pullScoreKills: pullScore.kills,
      pullScoreStatus: pullScore.status,
      wclParseMedian: wclParseStatus === 'ok' ? Math.round(Number(parse?.median) * 10) / 10 : null,
      wclParseBosses: Number(parse?.bosses ?? 0),
      wclParseStatus,
      vaultScore: scores.vaultScore,
      preparednessScore: scores.preparednessScore,
      upgradesCompleted: scores.upgradesCompleted,
      upgradesMissing: scores.upgradesMissing,
    };
  };

  const syncedAt = [...parseRows.values()].map((row) => Number(row.synced_at));
  return {
    summary,
    lastParseSyncAt: syncedAt.length > 0 ? Math.max(...syncedAt) : null,
    ranked: summary.rankings.map(toRaider),
    belowMinimum: summary.belowMinimum
      .map(toRaider)
      .sort((a, b) => (b.pullScore ?? -1) - (a.pullScore ?? -1) || a.name.localeCompare(b.name)),
  };
}

export async function setBenchRoleOverride(
  dbInput: D1Database | undefined,
  blizzardCharId: number,
  role: BenchRole | null,
  userId: number
): Promise<void> {
  const db = getDatabase(dbInput);
  if (!role) {
    await db.prepare('DELETE FROM bench_role_overrides WHERE blizzard_char_id = ?').bind(blizzardCharId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO bench_role_overrides (blizzard_char_id, role, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(blizzard_char_id) DO UPDATE SET
         role = excluded.role,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(blizzardCharId, role, userId)
    .run();
}

async function upsertBenchFlag(
  db: D1Database,
  blizzardCharId: number,
  column: 'melee_ranged' | 'is_absent' | 'is_raid_leader',
  value: string | number | null,
  userId: number
): Promise<void> {
  // Only the touched column is written on conflict, so setting one flag never clobbers the others.
  await db
    .prepare(
      `INSERT INTO bench_flags (blizzard_char_id, ${column}, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(blizzard_char_id) DO UPDATE SET
         ${column} = excluded.${column},
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(blizzardCharId, value, userId)
    .run();
}

export async function setBenchMeleeRangedOverride(
  dbInput: D1Database | undefined,
  blizzardCharId: number,
  value: 'melee' | 'ranged' | null,
  userId: number
): Promise<void> {
  await upsertBenchFlag(getDatabase(dbInput), blizzardCharId, 'melee_ranged', value, userId);
}

export async function setBenchAbsent(
  dbInput: D1Database | undefined,
  blizzardCharId: number,
  isAbsent: boolean,
  userId: number
): Promise<void> {
  await upsertBenchFlag(getDatabase(dbInput), blizzardCharId, 'is_absent', isAbsent ? 1 : 0, userId);
}

export async function setBenchRaidLeader(
  dbInput: D1Database | undefined,
  blizzardCharId: number,
  isRaidLeader: boolean,
  userId: number
): Promise<void> {
  await upsertBenchFlag(getDatabase(dbInput), blizzardCharId, 'is_raid_leader', isRaidLeader ? 1 : 0, userId);
}

/** Clears Absent for everyone at once (e.g. starting a fresh raid night) — RL and melee/ranged overrides are left untouched. */
export async function clearAllAbsent(dbInput: D1Database | undefined, userId: number): Promise<void> {
  const db = getDatabase(dbInput);
  await db
    .prepare(
      `UPDATE bench_flags SET is_absent = 0, updated_by_user_id = ?, updated_at = unixepoch() WHERE is_absent = 1`
    )
    .bind(userId)
    .run();
}
