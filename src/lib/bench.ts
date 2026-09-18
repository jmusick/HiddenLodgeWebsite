import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { WclRateLimitError, applyWclRateLimitBackoff, clearWclBackoff, queryWcl } from './wcl';
import {
  getDeathAnalysisNights,
  getDeathAnalysisSummary,
  requireAccessToken,
  type DeathAnalysisEntry,
  type DeathAnalysisSummary,
} from './death-analysis';

// Bench analysis (Admin > Bench): Death Analysis + each raider's median WCL
// parse. Parses are cached in bench_parses; scoring and the DPS/deaths weight
// slider run client-side on /admin/bench.

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
  totalDeathRate: number;
  role: BenchRole;
  autoRole: BenchRole;
  roleOverride: BenchRole | null;
  /** Median parse for `role` (WCL medianPerformanceAverage), null unless parseStatus is 'ok'. */
  parse: number | null;
  parseBosses: number;
  parseStatus: BenchParseStatus;
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
  if (pending.length === 0) return result;

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
  return result;
}

export async function getBenchData(dbInput?: D1Database): Promise<BenchData> {
  const db = getDatabase(dbInput);
  const summary = await getDeathAnalysisSummary(db);
  const charIds = benchCandidates(summary).map((entry) => entry.blizzardCharId);

  const [parseRows, overrideResult] = await Promise.all([
    loadParseRows(db, charIds),
    db.prepare('SELECT blizzard_char_id, role FROM bench_role_overrides').all<{ blizzard_char_id: number; role: string }>(),
  ]);
  const overrides = new Map<number, BenchRole>();
  for (const row of overrideResult.results ?? []) {
    if (isBenchRole(row.role)) overrides.set(Number(row.blizzard_char_id), row.role);
  }

  const toRaider = (entry: DeathAnalysisEntry): BenchRaider => {
    const row = parseRows.get(entry.blizzardCharId);
    const autoRole = pickAutoRole(row);
    const roleOverride = overrides.get(entry.blizzardCharId) ?? null;
    const role = roleOverride ?? autoRole;
    const parse = row ? roleParse(row, role) : null;
    const parseStatus: BenchParseStatus = !row ? 'pending' : !row.wcl_found ? 'not-found' : parse?.median == null ? 'no-role-parse' : 'ok';
    return {
      blizzardCharId: entry.blizzardCharId,
      name: entry.name,
      realm: entry.realm,
      className: entry.className,
      reportCount: entry.reportCount,
      fightsPresent: entry.fightsPresent,
      totalDeaths: entry.totalDeaths,
      weightedScore: entry.weightedScore,
      totalDeathRate: entry.totalDeathRate,
      role,
      autoRole,
      roleOverride,
      parse: parseStatus === 'ok' ? Math.round(Number(parse?.median) * 10) / 10 : null,
      parseBosses: Number(parse?.bosses ?? 0),
      parseStatus,
    };
  };

  const syncedAt = [...parseRows.values()].map((row) => Number(row.synced_at));
  return {
    summary,
    lastParseSyncAt: syncedAt.length > 0 ? Math.max(...syncedAt) : null,
    ranked: summary.rankings.map(toRaider),
    belowMinimum: summary.belowMinimum
      .map(toRaider)
      .sort((a, b) => (b.parse ?? -1) - (a.parse ?? -1) || a.name.localeCompare(b.name)),
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
