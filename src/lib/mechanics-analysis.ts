import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import {
  WclRateLimitError,
  applyWclRateLimitBackoff,
  loadWclCharacterLookup,
  matchWclActorCharId,
  queryWcl,
  type WclCharacterLookup,
  type WclFightRow,
} from './wcl';
import {
  CHARACTER_IDENTITY_CTE,
  deathAnalysisCutoffUtc,
  getDeathAnalysisNights,
  requireAccessToken,
} from './death-analysis';

// Per-boss mechanic leaderboards. Reuses Death Analysis's canonical raid-night
// reports (one per Thu/Fri night, Heroic/Mythic, last 90 days) and adds one
// WCL events query per mechanic per report.

// WCL difficulty ids: 4 Heroic, 5 Mythic — same scope as Death Analysis.
const QUALIFYING_DIFFICULTIES = new Set([4, 5]);
const DEFAULT_MAX_REPORTS_PER_RUN = 3;
/** See REFRESH_TIME_BUDGET_MS in death-analysis.ts; this runs after it in the same cron request. */
const REFRESH_TIME_BUDGET_MS = 6_000;
const EVENT_MAX_PAGES = 20;

export interface MechanicDefinition {
  key: string;
  /** Short label for the mechanic, e.g. "Orb Carries". */
  label: string;
  abilityId: number;
  abilityName: string;
  /** What one counted event means, e.g. "orb". */
  unit: string;
  unitPlural: string;
  description: string;
}

export interface BossDefinition {
  slug: string;
  name: string;
  encounterId: number;
  mechanics: MechanicDefinition[];
}

export const MECHANICS_BOSSES: BossDefinition[] = [
  {
    slug: 'coiled-altar',
    name: 'The Coiled Altar',
    encounterId: 3429,
    mechanics: [
      {
        key: 'coiled-altar-volatile-venom',
        label: 'Orb Carries',
        abilityId: 1282419,
        abilityName: 'Volatile Venom',
        unit: 'orb',
        unitPlural: 'orbs',
        description:
          'Each Volatile Venom debuff application is one orb picked up. More applications means more of the orb mechanic handled.',
      },
    ],
  },
];

function allMechanics(): Array<{ boss: BossDefinition; mechanic: MechanicDefinition }> {
  return MECHANICS_BOSSES.flatMap((boss) => boss.mechanics.map((mechanic) => ({ boss, mechanic })));
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function toPositiveInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export type MechanicRole = 'tank' | 'healer' | 'melee' | 'ranged';
export const MECHANIC_ROLES: MechanicRole[] = ['tank', 'healer', 'melee', 'ranged'];

// WCL CombatantInfo specID -> role. Unlisted specs are left unknown.
const ROLE_BY_SPEC_ID = new Map<number, MechanicRole>([
  // Tanks
  [73, 'tank'], [66, 'tank'], [250, 'tank'], [268, 'tank'], [104, 'tank'], [581, 'tank'],
  // Healers
  [65, 'healer'], [256, 'healer'], [257, 'healer'], [264, 'healer'], [270, 'healer'], [105, 'healer'], [1468, 'healer'],
  // Melee
  [71, 'melee'], [72, 'melee'], [70, 'melee'], [255, 'melee'], [259, 'melee'], [260, 'melee'], [261, 'melee'],
  [251, 'melee'], [252, 'melee'], [263, 'melee'], [269, 'melee'], [103, 'melee'], [577, 'melee'],
  // Ranged
  [253, 'ranged'], [254, 'ranged'], [258, 'ranged'], [262, 'ranged'], [62, 'ranged'], [63, 'ranged'], [64, 'ranged'],
  [265, 'ranged'], [266, 'ranged'], [267, 'ranged'], [102, 'ranged'], [1467, 'ranged'], [1473, 'ranged'], [1480, 'ranged'],
]);

export function parseMechanicRole(value: string | null | undefined): MechanicRole | null {
  return MECHANIC_ROLES.find((role) => role === value) ?? null;
}

/** The role with the most pulls; ties keep the first one seen. */
function mainRole(pullsByRole: Map<MechanicRole, number>): MechanicRole | null {
  let best: MechanicRole | null = null;
  for (const [role, pulls] of pullsByRole) {
    if (best === null || pulls > (pullsByRole.get(best) ?? 0)) best = role;
  }
  return best;
}

interface MechanicCharStats {
  pullsByRole: Map<MechanicRole, number>;
  pullsPresent: number;
  pullsHit: number;
  hitCount: number;
  bestPullCount: number;
}

type WclEvent = { type?: string; sourceID?: number; targetID?: number; fight?: number; specID?: number };

type EventPage = {
  reportData?: {
    report?: {
      events?: {
        data?: WclEvent[];
        nextPageTimestamp?: number | null;
      };
    };
  };
};

async function fetchEvents(
  accessToken: string,
  reportCode: string,
  fights: WclFightRow[],
  filter: { dataType: 'CombatantInfo' } | { dataType: 'Debuffs'; abilityId: number }
): Promise<WclEvent[]> {
  const fightIds = fights.map((fight) => Number(fight.id));
  let nextStart = Math.min(...fights.map((fight) => Number(fight.startTime ?? 0)));
  const end = Math.max(...fights.map((fight) => Number(fight.endTime ?? 0)));
  const isDebuff = filter.dataType === 'Debuffs';
  const all: WclEvent[] = [];

  for (let page = 0; page < EVENT_MAX_PAGES && nextStart <= end; page += 1) {
    const payload = await queryWcl<EventPage>(
      accessToken,
      isDebuff
        ? `
          query MechanicDebuffs($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!, $abilityID: Float!) {
            reportData {
              report(code: $code) {
                events(dataType: Debuffs, hostilityType: Friendlies, abilityID: $abilityID, fightIDs: $fightIDs, startTime: $startTime, endTime: $endTime) {
                  data
                  nextPageTimestamp
                }
              }
            }
          }
        `
        : `
          query MechanicCombatants($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!) {
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
      {
        code: reportCode,
        fightIDs: fightIds,
        startTime: nextStart,
        endTime: end,
        ...(isDebuff ? { abilityID: filter.abilityId } : {}),
      }
    );
    if (!payload) throw new Error(`Unable to load ${filter.dataType} events from Warcraft Logs.`);

    all.push(...(payload.reportData?.report?.events?.data ?? []));
    const nextPage = Number(payload.reportData?.report?.events?.nextPageTimestamp ?? 0);
    if (!Number.isFinite(nextPage) || nextPage <= nextStart) break;
    nextStart = nextPage;
  }
  return all;
}

async function syncReportMechanics(
  db: D1Database,
  accessToken: string,
  ownership: WclCharacterLookup,
  reportCode: string,
  mechanicKeys: Set<string>
): Promise<void> {
  const metadata = await queryWcl<{
    reportData?: {
      report?: {
        fights?: WclFightRow[];
        masterData?: { actors?: Array<{ id?: number; name?: string; server?: string }> };
      } | null;
    };
  }>(
    accessToken,
    `
      query MechanicReportMetadata($code: String!) {
        reportData {
          report(code: $code) {
            fights { id startTime endTime encounterID difficulty kill }
            masterData { actors(type: "Player") { id name server } }
          }
        }
      }
    `,
    { code: reportCode }
  );
  const report = metadata?.reportData?.report;
  if (!report) throw new Error('Unable to load Warcraft Logs report metadata.');

  const charIdByActorId = new Map<number, number>();
  for (const actor of report.masterData?.actors ?? []) {
    const actorId = toPositiveInt(actor.id);
    const charId = actorId ? matchWclActorCharId(actor, ownership) : null;
    if (actorId && charId) charIdByActorId.set(actorId, charId);
  }

  const targets = allMechanics().filter(({ mechanic }) => mechanicKeys.has(mechanic.key));
  const fightsByEncounter = new Map<number, WclFightRow[]>();
  for (const fight of report.fights ?? []) {
    const encounterId = toPositiveInt(fight.encounterID);
    if (!toPositiveInt(fight.id) || !QUALIFYING_DIFFICULTIES.has(toPositiveInt(fight.difficulty))) continue;
    if (!targets.some(({ boss }) => boss.encounterId === encounterId)) continue;
    const list = fightsByEncounter.get(encounterId) ?? [];
    list.push(fight);
    fightsByEncounter.set(encounterId, list);
  }

  // Who was in each relevant pull (and in which role), once for every boss.
  const presentByFight = new Map<number, Map<number, MechanicRole | null>>();
  const relevantFights = [...fightsByEncounter.values()].flat();
  if (relevantFights.length > 0) {
    for (const event of await fetchEvents(accessToken, reportCode, relevantFights, { dataType: 'CombatantInfo' })) {
      if (String(event.type ?? '').toLowerCase() !== 'combatantinfo') continue;
      const charId = charIdByActorId.get(toPositiveInt(event.sourceID));
      const fightId = toPositiveInt(event.fight);
      if (!charId || !fightId) continue;
      const present = presentByFight.get(fightId) ?? new Map<number, MechanicRole | null>();
      present.set(charId, ROLE_BY_SPEC_ID.get(toPositiveInt(event.specID)) ?? null);
      presentByFight.set(fightId, present);
    }
  }

  const statements = [];
  for (const { boss, mechanic } of targets) {
    const fights = fightsByEncounter.get(boss.encounterId) ?? [];
    const stats = new Map<number, MechanicCharStats>();
    const statsFor = (charId: number) => {
      let row = stats.get(charId);
      if (!row) {
        row = { pullsByRole: new Map(), pullsPresent: 0, pullsHit: 0, hitCount: 0, bestPullCount: 0 };
        stats.set(charId, row);
      }
      return row;
    };

    if (fights.length > 0) {
      const countsByFight = new Map<number, Map<number, number>>();
      const events = await fetchEvents(accessToken, reportCode, fights, { dataType: 'Debuffs', abilityId: mechanic.abilityId });
      for (const event of events) {
        if (event.type !== 'applydebuff') continue;
        const charId = charIdByActorId.get(toPositiveInt(event.targetID));
        const fightId = toPositiveInt(event.fight);
        if (!charId || !fightId) continue;
        const perChar = countsByFight.get(fightId) ?? new Map<number, number>();
        perChar.set(charId, (perChar.get(charId) ?? 0) + 1);
        countsByFight.set(fightId, perChar);
      }

      for (const fight of fights) {
        const fightId = Number(fight.id);
        const counts = countsByFight.get(fightId) ?? new Map<number, number>();
        const roles = presentByFight.get(fightId) ?? new Map<number, MechanicRole | null>();
        for (const charId of new Set([...roles.keys(), ...counts.keys()])) {
          const row = statsFor(charId);
          const count = counts.get(charId) ?? 0;
          const role = roles.get(charId);
          if (role) row.pullsByRole.set(role, (row.pullsByRole.get(role) ?? 0) + 1);
          row.pullsPresent += 1;
          row.hitCount += count;
          if (count > 0) row.pullsHit += 1;
          row.bestPullCount = Math.max(row.bestPullCount, count);
        }
      }
    }

    statements.push(
      db.prepare('DELETE FROM mechanics_analysis_stats WHERE report_code = ? AND mechanic_key = ?').bind(reportCode, mechanic.key),
      ...[...stats.entries()].map(([charId, row]) =>
        db
          .prepare(
            `INSERT INTO mechanics_analysis_stats
               (report_code, mechanic_key, blizzard_char_id, role, pulls_present, pulls_hit, hit_count, best_pull_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            reportCode,
            mechanic.key,
            charId,
            mainRole(row.pullsByRole),
            row.pullsPresent,
            row.pullsHit,
            row.hitCount,
            row.bestPullCount
          )
      ),
      db
        .prepare(
          `INSERT INTO mechanics_analysis_reports (report_code, mechanic_key, pulls, synced_at)
           VALUES (?, ?, ?, unixepoch())
           ON CONFLICT(report_code, mechanic_key) DO UPDATE SET pulls = excluded.pulls, synced_at = excluded.synced_at`
        )
        .bind(reportCode, mechanic.key, fights.length)
    );
  }
  await db.batch(statements);
}

export interface MechanicsAnalysisRefreshResult {
  pendingReports: number;
  processed: number;
  failed: number;
  remaining: number;
  rateLimited: boolean;
  budgetExhausted: boolean;
}

/**
 * Syncs mechanics for canonical Death Analysis reports that don't have every
 * configured mechanic yet (newest first). Adding a mechanic backfills it.
 */
export async function refreshMechanicsAnalysis(
  dbInput?: D1Database,
  options?: { maxReports?: number }
): Promise<MechanicsAnalysisRefreshResult> {
  const db = getDatabase(dbInput);
  const deadline = Date.now() + REFRESH_TIME_BUDGET_MS;
  const maxReports = Math.max(1, Math.floor(options?.maxReports ?? DEFAULT_MAX_REPORTS_PER_RUN));

  // Rows for reports Death Analysis has pruned (or never kept) are dropped.
  await db.batch([
    db.prepare('DELETE FROM mechanics_analysis_stats WHERE report_code NOT IN (SELECT report_code FROM death_analysis_reports)'),
    db.prepare('DELETE FROM mechanics_analysis_reports WHERE report_code NOT IN (SELECT report_code FROM death_analysis_reports)'),
  ]);

  const canonical = (await getDeathAnalysisNights(db))
    .map((night) => night.canonical)
    .filter((report): report is NonNullable<typeof report> => Boolean(report && report.bossPulls > 0))
    .sort((a, b) => b.startUtc - a.startUtc);

  const syncedResult = await db
    .prepare('SELECT report_code, mechanic_key FROM mechanics_analysis_reports')
    .all<{ report_code: string; mechanic_key: string }>();
  const synced = new Set((syncedResult.results ?? []).map((row) => `${row.report_code}::${row.mechanic_key}`));
  const keys = allMechanics().map(({ mechanic }) => mechanic.key);
  const pending = canonical
    .map((report) => ({ code: report.code, missing: new Set(keys.filter((key) => !synced.has(`${report.code}::${key}`))) }))
    .filter((report) => report.missing.size > 0);

  const result: MechanicsAnalysisRefreshResult = {
    pendingReports: pending.length,
    processed: 0,
    failed: 0,
    remaining: 0,
    rateLimited: false,
    budgetExhausted: false,
  };
  if (pending.length === 0) return result;

  const accessToken = await requireAccessToken(db);
  const ownership = await loadWclCharacterLookup(db);
  for (const report of pending.slice(0, maxReports)) {
    if (Date.now() >= deadline) {
      result.budgetExhausted = true;
      break;
    }
    try {
      await syncReportMechanics(db, accessToken, ownership, report.code, report.missing);
      result.processed += 1;
    } catch (error) {
      if (error instanceof WclRateLimitError) {
        await applyWclRateLimitBackoff(db, error);
        result.rateLimited = true;
        break;
      }
      result.failed += 1;
      console.warn('[mechanics-analysis] failed to sync report', {
        reportCode: report.code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  result.remaining = Math.max(0, pending.length - result.processed);
  return result;
}

export interface MechanicLeaderboardEntry {
  blizzardCharId: number;
  name: string;
  realm: string;
  className: string;
  /** Role played in the most counted pulls; null if no spec was recorded. */
  role: MechanicRole | null;
  nights: number;
  pullsPresent: number;
  pullsHit: number;
  hitCount: number;
  bestPullCount: number;
  perPull: number;
  /** Share of every counted event across the whole raid (all roles). */
  share: number;
}

export interface MechanicLeaderboard {
  boss: BossDefinition;
  mechanic: MechanicDefinition;
  range: MechanicRange;
  /** Role filter applied to `entries`; null shows everyone. */
  role: MechanicRole | null;
  cutoffUtc: number;
  nightsCounted: number;
  nightsPending: number;
  pullsCounted: number;
  /** Raid-wide total, before the role filter. */
  totalCount: number;
  lastSyncedAt: number | null;
  reports: Array<{ code: string; nightKey: string; pulls: number }>;
  entries: MechanicLeaderboardEntry[];
}

export function findBoss(slug: string | null | undefined): BossDefinition {
  return MECHANICS_BOSSES.find((boss) => boss.slug === slug) ?? MECHANICS_BOSSES[0];
}

/** `latest`: the most recent counted night that pulled this boss. `all`: every counted night (last 90 days). */
export type MechanicRange = 'latest' | 'all';

export function parseMechanicRange(value: string | null | undefined): MechanicRange {
  return value === 'latest' ? 'latest' : 'all';
}

export async function getMechanicLeaderboard(
  boss: BossDefinition,
  mechanic: MechanicDefinition,
  range: MechanicRange = 'all',
  role: MechanicRole | null = null,
  dbInput?: D1Database
): Promise<MechanicLeaderboard> {
  const db = getDatabase(dbInput);
  const canonicalNights = (await getDeathAnalysisNights(db)).filter((night) => night.canonical && night.canonical.bossPulls > 0);
  const codes = canonicalNights.map((night) => night.canonical!.code);

  const leaderboard: MechanicLeaderboard = {
    boss,
    mechanic,
    range,
    role,
    cutoffUtc: deathAnalysisCutoffUtc(),
    nightsCounted: 0,
    nightsPending: 0,
    pullsCounted: 0,
    totalCount: 0,
    lastSyncedAt: null,
    reports: [],
    entries: [],
  };
  if (codes.length === 0) return leaderboard;

  // D1 caps bound parameters at 100; 90 days of Thu/Fri nights is ~26 codes.
  const reportsResult = await db
    .prepare(
      `SELECT report_code, pulls, synced_at FROM mechanics_analysis_reports
       WHERE mechanic_key = ? AND report_code IN (${codes.map(() => '?').join(', ')})`
    )
    .bind(mechanic.key, ...codes)
    .all<Record<string, unknown>>();

  const syncedByCode = new Map<string, { pulls: number; syncedAt: number }>();
  for (const row of reportsResult.results ?? []) {
    syncedByCode.set(String(row.report_code), { pulls: toPositiveInt(row.pulls), syncedAt: toPositiveInt(row.synced_at) });
  }
  // Newest night first, so "latest" is reports[0].
  for (const night of [...canonicalNights].sort((a, b) => b.nightKey.localeCompare(a.nightKey))) {
    const synced = syncedByCode.get(night.canonical!.code);
    if (!synced) {
      leaderboard.nightsPending += 1;
      continue;
    }
    leaderboard.lastSyncedAt = Math.max(leaderboard.lastSyncedAt ?? 0, synced.syncedAt);
    if (synced.pulls > 0) {
      leaderboard.reports.push({ code: night.canonical!.code, nightKey: night.nightKey, pulls: synced.pulls });
    }
  }
  if (range === 'latest') leaderboard.reports = leaderboard.reports.slice(0, 1);
  leaderboard.nightsCounted = leaderboard.reports.length;
  leaderboard.pullsCounted = leaderboard.reports.reduce((sum, report) => sum + report.pulls, 0);
  if (leaderboard.reports.length === 0) return leaderboard;

  const selectedCodes = leaderboard.reports.map((report) => report.code);
  // One row per character per role played; merged below so each raider gets
  // one entry, labelled with the role they played in the most pulls.
  const statsResult = await db
    .prepare(
      `${CHARACTER_IDENTITY_CTE}
       SELECT
         s.blizzard_char_id,
         s.role,
         COALESCE(ic.name, 'Unknown') AS name,
         COALESCE(ic.realm, 'Unknown') AS realm,
         COALESCE(ic.class_name, 'Unknown') AS class_name,
         COUNT(*) AS nights,
         SUM(s.pulls_present) AS pulls_present,
         SUM(s.pulls_hit) AS pulls_hit,
         SUM(s.hit_count) AS hit_count,
         MAX(s.best_pull_count) AS best_pull_count
       FROM mechanics_analysis_stats s
       LEFT JOIN identity_choice ic ON ic.blizzard_char_id = s.blizzard_char_id AND ic.rn = 1
       WHERE s.mechanic_key = ? AND s.report_code IN (${selectedCodes.map(() => '?').join(', ')})
       GROUP BY s.blizzard_char_id, s.role, ic.name, ic.realm, ic.class_name`
    )
    .bind(mechanic.key, ...selectedCodes)
    .all<Record<string, unknown>>();

  const byCharId = new Map<number, MechanicLeaderboardEntry & { pullsByRole: Map<MechanicRole, number> }>();
  for (const row of statsResult.results ?? []) {
    const blizzardCharId = toPositiveInt(row.blizzard_char_id);
    const pullsPresent = toPositiveInt(row.pulls_present);
    if (blizzardCharId <= 0 || pullsPresent <= 0) continue;
    let entry = byCharId.get(blizzardCharId);
    if (!entry) {
      entry = {
        blizzardCharId,
        name: String(row.name),
        realm: String(row.realm),
        className: String(row.class_name),
        role: null,
        nights: 0,
        pullsPresent: 0,
        pullsHit: 0,
        hitCount: 0,
        bestPullCount: 0,
        perPull: 0,
        share: 0,
        pullsByRole: new Map(),
      };
      byCharId.set(blizzardCharId, entry);
    }
    // A role swap mid-night can't split a report row, so nights can't double count.
    entry.nights += toPositiveInt(row.nights);
    entry.pullsPresent += pullsPresent;
    entry.pullsHit += toPositiveInt(row.pulls_hit);
    entry.hitCount += toPositiveInt(row.hit_count);
    entry.bestPullCount = Math.max(entry.bestPullCount, toPositiveInt(row.best_pull_count));
    const role = parseMechanicRole(row.role as string | null);
    if (role) entry.pullsByRole.set(role, (entry.pullsByRole.get(role) ?? 0) + pullsPresent);
  }

  for (const { pullsByRole, ...entry } of byCharId.values()) {
    entry.role = mainRole(pullsByRole);
    entry.perPull = entry.hitCount / entry.pullsPresent;
    leaderboard.totalCount += entry.hitCount;
    leaderboard.entries.push(entry);
  }
  for (const entry of leaderboard.entries) {
    entry.share = leaderboard.totalCount > 0 ? entry.hitCount / leaderboard.totalCount : 0;
  }
  if (role) leaderboard.entries = leaderboard.entries.filter((entry) => entry.role === role);
  leaderboard.entries.sort(
    (a, b) => b.hitCount - a.hitCount || b.perPull - a.perPull || a.name.localeCompare(b.name)
  );
  return leaderboard;
}
