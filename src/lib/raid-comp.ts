import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { getBenchData, type BenchRaider } from './bench';
import { ALL_RAID_BUFFS, CONFIGURABLE_RAID_BUFFS, DEFAULT_CONFIGURABLE_BUFF_MINIMUM, classRaidData } from './raid-teams';

export type UtilityMinimums = Map<string, number>;
export type BuffMinimums = Map<string, number>;

// Raid Comp (Tools menu, guild members; officers edit): a shared 20-man
// suggested comp built from Bench's own priority order. `raid_comp_settings`
// is the singleton input to "Regenerate"; `raid_comp_assignments` is the
// actual board, edited one raider at a time from the page.

export type RaidCompScale = 'percentile' | 'raw';

export interface RaidCompSettings {
  tankQuota: number;
  healerQuota: number;
  meleeDpsQuota: number;
  rangedDpsQuota: number;
  parseWeight: number;
  deathWeight: number;
  vaultWeight: number;
  preparednessWeight: number;
  upgradesWeight: number;
  scale: RaidCompScale;
}

export type AssignedRole = 'tank' | 'healer' | 'melee-dps' | 'ranged-dps';

export interface TempRaidCompCandidate {
  id: number;
  name: string;
  className: string;
  assignedRole: AssignedRole;
}

export interface RaidCompLoadoutSummary {
  id: number;
  name: string;
  assignmentCount: number;
  updatedAt: number;
}

const DEFAULT_SETTINGS: RaidCompSettings = {
  tankQuota: 2,
  healerQuota: 5,
  meleeDpsQuota: 7,
  rangedDpsQuota: 6,
  parseWeight: 50,
  deathWeight: 40,
  vaultWeight: 5,
  preparednessWeight: 5,
  upgradesWeight: 0,
  scale: 'percentile',
};
const MIN_GROUP_COUNT = 4;
/** A WoW raid group is a fixed 5 slots. */
export const MAX_GROUP_SIZE = 5;

/** Four primary groups cover a standard 20-player roster. Each player beyond that gets an overflow group so odd/even group numbers stay balanced. */
export function getRaidCompGroupCount(settings: Pick<RaidCompSettings, 'tankQuota' | 'healerQuota' | 'meleeDpsQuota' | 'rangedDpsQuota'>): number {
  const rosterSize = Math.max(0, settings.tankQuota + settings.healerQuota + settings.meleeDpsQuota + settings.rangedDpsQuota);
  return MIN_GROUP_COUNT + Math.max(0, rosterSize - MIN_GROUP_COUNT * MAX_GROUP_SIZE);
}

// Death Knight/Demon Hunter/Monk/Paladin/Rogue/Warrior only have melee DPS
// specs; Evoker/Hunter/Mage/Priest/Warlock only have ranged. Druid and Shaman
// have both, so without a synced WCL spec (BenchRaider.mechanicRole) they
// default to ranged — same fallback the client board uses.
const MELEE_CLASSES = new Set(['Death Knight', 'Demon Hunter', 'Monk', 'Paladin', 'Rogue', 'Warrior']);
const RANGED_CLASSES = new Set(['Evoker', 'Hunter', 'Mage', 'Priest', 'Warlock']);

function meleeOrRanged(raider: BenchRaider): 'melee' | 'ranged' {
  if (raider.meleeRangedOverride) return raider.meleeRangedOverride;
  if (raider.mechanicRole === 'melee') return 'melee';
  if (raider.mechanicRole === 'ranged') return 'ranged';
  if (MELEE_CLASSES.has(raider.className)) return 'melee';
  if (RANGED_CLASSES.has(raider.className)) return 'ranged';
  return 'ranged';
}

export function naturalRole(raider: BenchRaider): AssignedRole {
  if (raider.role === 'tank') return 'tank';
  if (raider.role === 'healer') return 'healer';
  return meleeOrRanged(raider) === 'melee' ? 'melee-dps' : 'ranged-dps';
}

/** Tie-aware percentile for higher-is-better scores: every tied highest value receives 1 (100%). */
function percentRank(pool: number[], value: number): number {
  if (pool.length <= 1) return 1;
  return (pool.filter((entry) => entry <= value).length - 1) / (pool.length - 1);
}

/** Tie-aware percentile for lower-is-better scores: every tied lowest value receives 1 (100%). */
function inversePercentRank(pool: number[], value: number): number {
  if (pool.length <= 1) return 1;
  return (pool.filter((entry) => entry >= value).length - 1) / (pool.length - 1);
}

/**
 * Share of the best value in the pool, 0–100. Used for raw counts like weekly
 * upgrades where a percentile reads badly: doing nothing should score 0, and
 * doing twice as much as someone else should visibly score about twice as
 * high. (Percentile instead gives the whole tied-at-zero block credit for
 * everyone they tie with, which is most of the roster most weeks.)
 */
function relativeToMax(pool: number[], value: number): number {
  const max = Math.max(0, ...pool);
  return max > 0 ? (value / max) * 100 : 0;
}

/**
 * A metric where every raider holds the same value can't separate anyone, and
 * because the percentiles above are tie-aware it would hand all of them 100%.
 * That silently spends its weight on a constant, diluting the metrics that do
 * discriminate — so flat metrics are dropped and their weight is redistributed.
 */
function hasVariance(pool: number[]): boolean {
  return pool.length > 1 && pool.some((entry) => entry !== pool[0]);
}

/**
 * Weighted blend over only the metrics that vary across the pool. Dividing by
 * the active weight (instead of a flat 100) both redistributes a dropped
 * metric's share proportionally and keeps Combined on a 0–100 scale. When all
 * five vary and total 100 this is identical to a plain weighted average.
 */
export function combineScores(components: ReadonlyArray<{ weight: number; value: number; varies: boolean }>): number {
  let weighted = 0;
  let activeWeight = 0;
  for (const component of components) {
    if (!component.varies) continue;
    weighted += component.weight * component.value;
    activeWeight += component.weight;
  }
  return activeWeight > 0 ? weighted / activeWeight : 0;
}

/** Same combined-score formula as Bench Order, best raider first. */
function rankByPriority(raiders: BenchRaider[], settings: RaidCompSettings): BenchRaider[] {
  const scored = raiders.filter((raider) => raider.pullScoreStatus === 'ok');
  const deathPool = scored.map((raider) => raider.adjustedScore);
  const pullScorePool = scored.map((raider) => raider.pullScore ?? 0);
  const vaultPool = scored.map((raider) => raider.vaultScore);
  const preparednessPool = scored.map((raider) => raider.preparednessScore);
  const upgradesPool = scored.map((raider) => raider.upgradesCompleted);
  const varies = {
    pullScore: hasVariance(pullScorePool),
    death: hasVariance(deathPool),
    vault: hasVariance(vaultPool),
    preparedness: hasVariance(preparednessPool),
    upgrades: hasVariance(upgradesPool),
  };

  return scored
    .map((raider) => {
      const pullScore = raider.pullScore ?? 0;
      const pullScoreValue = settings.scale === 'raw' ? pullScore : 100 * percentRank(pullScorePool, pullScore);
      const deathPct = 100 * inversePercentRank(deathPool, raider.adjustedScore);
      const vaultPct = 100 * percentRank(vaultPool, raider.vaultScore);
      const preparednessPct = 100 * percentRank(preparednessPool, raider.preparednessScore);
      const upgradesPct = relativeToMax(upgradesPool, raider.upgradesCompleted);
      const combined = combineScores([
        { weight: settings.parseWeight, value: pullScoreValue, varies: varies.pullScore },
        { weight: settings.deathWeight, value: deathPct, varies: varies.death },
        { weight: settings.vaultWeight, value: vaultPct, varies: varies.vault },
        { weight: settings.preparednessWeight, value: preparednessPct, varies: varies.preparedness },
        { weight: settings.upgradesWeight, value: upgradesPct, varies: varies.upgrades },
      ]);
      return { raider, deathPct, combined };
    })
    .sort((a, b) => b.combined - a.combined || b.deathPct - a.deathPct || a.raider.name.localeCompare(b.raider.name))
    .map((row) => row.raider);
}

/** Picks `raider.isRaidLeader` members first (regardless of score), then fills the rest of the quota by priority. */
function withForced(pool: BenchRaider[], quota: number): BenchRaider[] {
  const forced = pool.filter((raider) => raider.isRaidLeader);
  const rest = pool.filter((raider) => !raider.isRaidLeader);
  return [...forced, ...rest.slice(0, Math.max(quota - forced.length, 0))];
}

interface BuffPicks {
  tank: BenchRaider[];
  healer: BenchRaider[];
  melee: BenchRaider[];
  ranged: BenchRaider[];
}

function bucketFor(role: AssignedRole): keyof BuffPicks {
  if (role === 'tank') return 'tank';
  if (role === 'healer') return 'healer';
  return role === 'melee-dps' ? 'melee' : 'ranged';
}

interface CoverageRequirement {
  /** How many current picks must provide this (1 for every raid buff; officer-configured for utility, skipped when 0). */
  minCount: number;
  provides(className: string): boolean;
}

/**
 * Swaps in an unpicked raider for each requirement (a raid buff, or a
 * utility item with an officer-set minimum) that isn't yet at its minCount,
 * replacing the lowest-priority same-role pick — but only when that pick
 * isn't required to stay for some *other* requirement to keep its own
 * minimum (so a swap never trades one gap for another), and never a raid
 * leader. Best-effort: a requirement with no available candidate, or whose
 * only candidates would require bumping a raid leader or another
 * requirement's last provider, stays short.
 */
function improveCoverage(picks: BuffPicks, priorityOrder: BenchRaider[], requirements: CoverageRequirement[]): void {
  const priorityIndex = new Map(priorityOrder.map((raider, index) => [raider.blizzardCharId, index]));
  const allPicked = () => [...picks.tank, ...picks.healer, ...picks.melee, ...picks.ranged];

  const isSafeToRemove = (candidate: BenchRaider): boolean => {
    if (candidate.isRaidLeader) return false;
    const picked = allPicked();
    return requirements.every((req) => {
      if (!req.provides(candidate.className)) return true;
      const count = picked.filter((raider) => req.provides(raider.className)).length;
      return count - 1 >= req.minCount;
    });
  };

  for (const req of requirements) {
    // A requirement can need more than one swap (e.g. "2 Demonic Gateways"), so retry up to its own minCount times.
    for (let attempt = 0; attempt < req.minCount; attempt += 1) {
      const pickedIds = new Set(allPicked().map((raider) => raider.blizzardCharId));
      const currentCount = allPicked().filter((raider) => req.provides(raider.className)).length;
      if (currentCount >= req.minCount) break;

      const candidate = priorityOrder.find((raider) => !pickedIds.has(raider.blizzardCharId) && req.provides(raider.className));
      if (!candidate) break;

      const bucket = picks[bucketFor(naturalRole(candidate))];
      if (bucket.length === 0) break;

      const removalOrder = [...bucket].sort(
        (a, b) => (priorityIndex.get(b.blizzardCharId) ?? 0) - (priorityIndex.get(a.blizzardCharId) ?? 0)
      ); // worst (lowest priority) first
      const removed = removalOrder.find(isSafeToRemove);
      if (!removed) break;

      bucket.splice(bucket.indexOf(removed), 1, candidate);
    }
  }
}

function coverageRequirements(utilityMinimums: UtilityMinimums, buffMinimums: BuffMinimums): CoverageRequirement[] {
  const buffRequirements = ALL_RAID_BUFFS.map((buff) => ({
    minCount: CONFIGURABLE_RAID_BUFFS.includes(buff) ? buffMinimums.get(buff) ?? DEFAULT_CONFIGURABLE_BUFF_MINIMUM : 1,
    provides: (className: string) => classRaidData(className).buffs.includes(buff),
  })).filter((req) => req.minCount > 0);
  const utilityRequirements = [...utilityMinimums.entries()]
    .filter(([, minCount]) => minCount > 0)
    .map(([utility, minCount]) => ({
      minCount,
      provides: (className: string) => classRaidData(className).utility.includes(utility),
    }));
  return [...buffRequirements, ...utilityRequirements];
}

/**
 * Fills tank/healer/melee-DPS/ranged-DPS quotas from the priority order (best raider first).
 * `isAbsent` raiders are never picked; `isRaidLeader` raiders are always
 * picked (bumping the lowest-priority same-role pick if the quota is
 * otherwise full). A pass then tries to swap in a raider for every raid buff
 * (minimum 1, except per-target buffs like Hunter's Mark which use an
 * officer-set minimum the same as utility) and every utility item with an
 * officer-set minimum (e.g. "2 Demonic Gateways") that isn't yet met — see
 * improveCoverage.
 *
 * Group placement isn't a plain round-robin: tanks only ever go in groups 1
 * and 2 (alternating), healers get one per group before doubling up, and DPS
 * are placed to keep the summed Pull Score of tanks + DPS as even as
 * possible between odd- and even-numbered groups, with melee/ranged role
 * balance and then the least-loaded eligible group only breaking ties.
 * Healers use the same Pull-Score-parity preference once they'd otherwise tie
 * on headcount, so both halves of the raid end up roughly equal in total
 * Coverage-panel-style Pull Score. Once the four primary groups are full, every
 * player beyond the 20-player standard gets their own overflow group. This
 * keeps the odd/even group split balanced (21 is 5/5/5/5/1; 22 is
 * 5/5/5/5/1/1), while no group can exceed five players.
 */
export function buildAssignments(
  priorityOrder: BenchRaider[],
  quotas: RaidCompSettings,
  utilityMinimums: UtilityMinimums = new Map(),
  buffMinimums: BuffMinimums = new Map()
): Map<number, number> {
  const eligible = priorityOrder.filter((raider) => !raider.isAbsent);

  const tanks: BenchRaider[] = [];
  const healers: BenchRaider[] = [];
  const melee: BenchRaider[] = [];
  const ranged: BenchRaider[] = [];
  for (const raider of eligible) {
    const role = naturalRole(raider);
    if (role === 'tank') tanks.push(raider);
    else if (role === 'healer') healers.push(raider);
    else if (role === 'melee-dps') melee.push(raider);
    else ranged.push(raider);
  }

  const pickedTanks = withForced(tanks, quotas.tankQuota);
  const pickedHealers = withForced(healers, quotas.healerQuota);

  const picks: BuffPicks = {
    tank: [...pickedTanks],
    healer: [...pickedHealers],
    melee: withForced(melee, quotas.meleeDpsQuota),
    ranged: withForced(ranged, quotas.rangedDpsQuota),
  };
  improveCoverage(picks, eligible, coverageRequirements(utilityMinimums, buffMinimums));

  const finalDps: BenchRaider[] = [];
  for (let i = 0; i < Math.max(picks.melee.length, picks.ranged.length); i += 1) {
    if (i < picks.melee.length) finalDps.push(picks.melee[i]);
    if (i < picks.ranged.length) finalDps.push(picks.ranged[i]);
  }

  const assignments = new Map<number, number>();
  const groupCount = getRaidCompGroupCount(quotas);
  const groupCounts = new Array(groupCount).fill(0);
  const groupCapacities = new Array(groupCount).fill(1);
  groupCapacities.fill(MAX_GROUP_SIZE, 0, MIN_GROUP_COUNT);

  // Tanks alternate strictly between groups 1 and 2 — never 3 or 4. Their
  // Pull Score still counts toward nonHealerParitySum below, since tank/DPS
  // Pull Score balance is judged across the whole odd/even split, not DPS alone.
  const nonHealerParitySum: [number, number] = [0, 0];
  let tankCursor = 0;
  for (const raider of picks.tank) {
    let skipped = 0;
    while (groupCounts[tankCursor] >= MAX_GROUP_SIZE) {
      tankCursor = tankCursor === 0 ? 1 : 0;
      skipped += 1;
      if (skipped >= 2) break;
    }
    if (skipped >= 2) break; // both groups 1 and 2 are full
    assignments.set(raider.blizzardCharId, tankCursor + 1);
    groupCounts[tankCursor] += 1;
    nonHealerParitySum[tankCursor % 2] += raider.pullScore ?? 0;
    tankCursor = tankCursor === 0 ? 1 : 0;
  }

  // Healers spread across the four primary groups before any group gets a
  // second (tracked via healerCounts), same as the old plain round-robin, but
  // when several groups are tied on healer count it now prefers whichever
  // parity has the lower cumulative healer Pull Score so healer strength stays
  // balanced between odd and even groups too. Overflow groups are still one
  // player each once the primary groups are full.
  const healerCounts = new Array(groupCount).fill(0);
  const healerParitySum: [number, number] = [0, 0];
  const placeHealers = (raiders: BenchRaider[]) => {
    for (const raider of raiders) {
      const primaryCandidates = Array.from({ length: MIN_GROUP_COUNT }, (_, index) => index).filter(
        (index) => groupCounts[index] < groupCapacities[index]
      );
      const candidates = primaryCandidates.length > 0
        ? primaryCandidates
        : groupCounts.map((_, index) => index).filter((index) => index >= MIN_GROUP_COUNT && groupCounts[index] < groupCapacities[index]);
      if (candidates.length === 0) return;

      candidates.sort((a, b) => {
        const healerCountDelta = healerCounts[a] - healerCounts[b];
        if (healerCountDelta !== 0) return healerCountDelta;
        const parityDelta = healerParitySum[a % 2] - healerParitySum[b % 2];
        if (parityDelta !== 0) return parityDelta;
        return groupCounts[a] - groupCounts[b] || a - b;
      });

      const group = candidates[0];
      assignments.set(raider.blizzardCharId, group + 1);
      groupCounts[group] += 1;
      healerCounts[group] += 1;
      healerParitySum[group % 2] += raider.pullScore ?? 0;
    }
  };
  placeHealers(picks.healer);

  // Melee and ranged DPS are placed to prioritize keeping the whole
  // tank/DPS Pull Score total even between odd- and even-numbered groups
  // (nonHealerParitySum, seeded above by the already-placed tanks); melee
  // vs. ranged role balance within a group (dpsRoleCounts) and then total
  // group size only break ties once Pull Score is even. A group that is already
  // full (often due to tanks or healers) is skipped, so this is
  // deliberately best-effort rather than a hard guarantee.
  const dpsRoleCounts = new Map<number, Record<'melee-dps' | 'ranged-dps', number>>();
  const placeDps = (raiders: BenchRaider[]) => {
    for (const raider of raiders) {
      const role = naturalRole(raider);
      if (role !== 'melee-dps' && role !== 'ranged-dps') continue;

      const primaryCandidates = Array.from({ length: MIN_GROUP_COUNT }, (_, index) => index).filter(
        (index) => groupCounts[index] < groupCapacities[index]
      );
      const candidates = primaryCandidates.length > 0
        ? primaryCandidates
        : groupCounts.map((_, index) => index).filter((index) => index >= MIN_GROUP_COUNT && groupCounts[index] < groupCapacities[index]);
      if (candidates.length === 0) return;

      candidates.sort((a, b) => {
        const parityDelta = nonHealerParitySum[a % 2] - nonHealerParitySum[b % 2]; // Group 1 is odd, Group 2 is even.
        if (parityDelta !== 0) return parityDelta;
        const roleDelta = (dpsRoleCounts.get(a)?.[role] ?? 0) - (dpsRoleCounts.get(b)?.[role] ?? 0);
        if (roleDelta !== 0) return roleDelta;
        return groupCounts[a] - groupCounts[b] || a - b;
      });

      const group = candidates[0];
      assignments.set(raider.blizzardCharId, group + 1);
      groupCounts[group] += 1;
      nonHealerParitySum[group % 2] += raider.pullScore ?? 0;
      const counts = dpsRoleCounts.get(group) ?? { 'melee-dps': 0, 'ranged-dps': 0 };
      counts[role] += 1;
      dpsRoleCounts.set(group, counts);
    }
  };
  placeDps(finalDps);
  return assignments;
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

export async function getRaidCompSettings(dbInput?: D1Database): Promise<RaidCompSettings> {
  const db = getDatabase(dbInput);
  const row = await db
    .prepare(
      'SELECT tank_quota, healer_quota, melee_dps_quota, ranged_dps_quota, parse_weight, death_weight, vault_weight, preparedness_weight, upgrades_weight, scale FROM raid_comp_settings WHERE id = 1'
    )
    .first<{
      tank_quota: number;
      healer_quota: number;
      melee_dps_quota: number;
      ranged_dps_quota: number;
      parse_weight: number;
      death_weight: number;
      vault_weight: number;
      preparedness_weight: number;
      upgrades_weight: number;
      scale: string;
    }>();
  if (!row) return DEFAULT_SETTINGS;
  return {
    tankQuota: Number(row.tank_quota),
    healerQuota: Number(row.healer_quota),
    meleeDpsQuota: Number(row.melee_dps_quota),
    rangedDpsQuota: Number(row.ranged_dps_quota),
    parseWeight: Number(row.parse_weight),
    deathWeight: Number(row.death_weight),
    vaultWeight: Number(row.vault_weight),
    preparednessWeight: Number(row.preparedness_weight),
    upgradesWeight: Number(row.upgrades_weight),
    scale: row.scale === 'raw' ? 'raw' : 'percentile',
  };
}

export async function getUtilityMinimums(dbInput?: D1Database): Promise<UtilityMinimums> {
  const db = getDatabase(dbInput);
  const result = await db
    .prepare('SELECT utility_name, minimum_count FROM raid_comp_utility_minimums')
    .all<{ utility_name: string; minimum_count: number }>();
  return new Map((result.results ?? []).map((row) => [row.utility_name, Number(row.minimum_count)]));
}

export async function setUtilityMinimum(
  dbInput: D1Database | undefined,
  utilityName: string,
  minimumCount: number,
  userId: number
): Promise<void> {
  const db = getDatabase(dbInput);
  await db
    .prepare(
      `INSERT INTO raid_comp_utility_minimums (utility_name, minimum_count, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(utility_name) DO UPDATE SET
         minimum_count = excluded.minimum_count,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(utilityName, Math.max(0, Math.floor(minimumCount)), userId)
    .run();
}

/** Officer-set minimum providers for a per-target raid buff (see CONFIGURABLE_RAID_BUFFS); a missing row falls back to the fixed default (1). */
export async function getBuffMinimums(dbInput?: D1Database): Promise<BuffMinimums> {
  const db = getDatabase(dbInput);
  const result = await db
    .prepare('SELECT buff_name, minimum_count FROM raid_comp_buff_minimums')
    .all<{ buff_name: string; minimum_count: number }>();
  return new Map((result.results ?? []).map((row) => [row.buff_name, Number(row.minimum_count)]));
}

export async function setBuffMinimum(
  dbInput: D1Database | undefined,
  buffName: string,
  minimumCount: number,
  userId: number
): Promise<void> {
  if (!CONFIGURABLE_RAID_BUFFS.includes(buffName)) throw new Error('Not a configurable raid buff.');
  const db = getDatabase(dbInput);
  await db
    .prepare(
      `INSERT INTO raid_comp_buff_minimums (buff_name, minimum_count, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(buff_name) DO UPDATE SET
         minimum_count = excluded.minimum_count,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(buffName, Math.max(0, Math.floor(minimumCount)), userId)
    .run();
}

export async function getRaidCompAssignments(dbInput?: D1Database): Promise<Map<number, number>> {
  const db = getDatabase(dbInput);
  const result = await db
    .prepare('SELECT blizzard_char_id, raid_group FROM raid_comp_assignments')
    .all<{ blizzard_char_id: number; raid_group: number }>();
  return new Map((result.results ?? []).map((row) => [Number(row.blizzard_char_id), Number(row.raid_group)]));
}

/**
 * Empties the board — every raider goes back to the bench. Quotas, weights,
 * utility minimums, Absent/RL flags, and saved loadouts are all left alone, so
 * this only undoes placements (the same two tables Regenerate rewrites).
 */
export async function clearRaidComp(dbInput?: D1Database): Promise<void> {
  const db = getDatabase(dbInput);
  await db.batch([
    db.prepare('DELETE FROM raid_comp_assignments'),
    db.prepare('DELETE FROM raid_comp_manual_overrides'),
  ]);
}

/** Raider IDs whose current board/bench placement was changed manually after Regenerate. */
export async function getRaidCompManualOverrideIds(dbInput?: D1Database): Promise<Set<number>> {
  const result = await getDatabase(dbInput)
    .prepare('SELECT blizzard_char_id FROM raid_comp_manual_overrides')
    .all<{ blizzard_char_id: number }>();
  return new Set((result.results ?? []).map((row) => Number(row.blizzard_char_id)));
}

export async function getRaidCompLoadouts(dbInput?: D1Database): Promise<RaidCompLoadoutSummary[]> {
  const db = getDatabase(dbInput);
  const result = await db
    .prepare(
      `SELECT l.id, l.name, l.updated_at, COUNT(a.blizzard_char_id) AS assignment_count
       FROM raid_comp_loadouts l
       LEFT JOIN raid_comp_loadout_assignments a ON a.loadout_id = l.id
       GROUP BY l.id, l.name, l.updated_at
       ORDER BY l.updated_at DESC, l.name COLLATE NOCASE ASC`
    )
    .all<{ id: number; name: string; updated_at: number; assignment_count: number }>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    name: row.name,
    assignmentCount: Number(row.assignment_count),
    updatedAt: Number(row.updated_at),
  }));
}

function parseLoadoutSettings(value: string): RaidCompSettings {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const readNumber = (field: keyof RaidCompSettings): number => {
    const number = Number(parsed[field]);
    if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error('Saved loadout has invalid settings.');
    return number;
  };
  const scale = parsed.scale === 'raw' ? 'raw' : parsed.scale === 'percentile' ? 'percentile' : null;
  if (!scale) throw new Error('Saved loadout has invalid scale.');
  return {
    tankQuota: readNumber('tankQuota'),
    healerQuota: readNumber('healerQuota'),
    meleeDpsQuota: readNumber('meleeDpsQuota'),
    rangedDpsQuota: readNumber('rangedDpsQuota'),
    parseWeight: readNumber('parseWeight'),
    deathWeight: readNumber('deathWeight'),
    vaultWeight: readNumber('vaultWeight'),
    preparednessWeight: readNumber('preparednessWeight'),
    upgradesWeight: readNumber('upgradesWeight'),
    scale,
  };
}

function parseLoadoutUtilityMinimums(value: string): Array<[string, number]> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Saved loadout has invalid utility minimums.');
  return parsed.flatMap((entry): Array<[string, number]> => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
    const minimum = Number(entry[1]);
    return Number.isInteger(minimum) && minimum >= 0 ? [[entry[0], minimum]] : [];
  });
}

function parseLoadoutBuffMinimums(value: string): Array<[string, number]> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Saved loadout has invalid buff minimums.');
  return parsed.flatMap((entry): Array<[string, number]> => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !CONFIGURABLE_RAID_BUFFS.includes(entry[0])) return [];
    const minimum = Number(entry[1]);
    return Number.isInteger(minimum) && minimum >= 0 ? [[entry[0], minimum]] : [];
  });
}

function parseLoadoutManualOverrideIds(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Saved loadout has invalid manual placement markers.');
  return [...new Set(parsed.map(Number).filter((id) => Number.isInteger(id) && id !== 0))];
}

function writeRaidCompSettings(db: D1Database, settings: RaidCompSettings, userId: number) {
  return db
    .prepare(
      `INSERT INTO raid_comp_settings (
         id, tank_quota, healer_quota, dps_quota, melee_dps_quota, ranged_dps_quota, weight, parse_weight, death_weight, vault_weight, preparedness_weight, upgrades_weight,
         scale, updated_by_user_id, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         tank_quota = excluded.tank_quota,
         healer_quota = excluded.healer_quota,
         dps_quota = excluded.dps_quota,
         melee_dps_quota = excluded.melee_dps_quota,
         ranged_dps_quota = excluded.ranged_dps_quota,
         parse_weight = excluded.parse_weight,
         death_weight = excluded.death_weight,
         vault_weight = excluded.vault_weight,
         preparedness_weight = excluded.preparedness_weight,
         upgrades_weight = excluded.upgrades_weight,
         scale = excluded.scale,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(
      settings.tankQuota,
      settings.healerQuota,
      settings.meleeDpsQuota + settings.rangedDpsQuota,
      settings.meleeDpsQuota,
      settings.rangedDpsQuota,
      settings.parseWeight,
      settings.parseWeight,
      settings.deathWeight,
      settings.vaultWeight,
      settings.preparednessWeight,
      settings.upgradesWeight,
      settings.scale,
      userId
    );
}

/** Saves the current board and all generation settings under a reusable officer-facing name. */
export async function saveRaidCompLoadout(dbInput: D1Database | undefined, rawName: string, userId: number): Promise<void> {
  const name = rawName.trim();
  if (name.length < 1 || name.length > 80) throw new Error('Loadout names must be between 1 and 80 characters.');
  const db = getDatabase(dbInput);
  const [settings, utilityMinimums, buffMinimums, assignments, manualOverrideIds] = await Promise.all([
    getRaidCompSettings(db),
    getUtilityMinimums(db),
    getBuffMinimums(db),
    getRaidCompAssignments(db),
    getRaidCompManualOverrideIds(db),
  ]);
  await db
    .prepare(
      `INSERT INTO raid_comp_loadouts (name, settings_json, utility_minimums_json, buff_minimums_json, manual_override_ids_json, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(name) DO UPDATE SET
         settings_json = excluded.settings_json,
         utility_minimums_json = excluded.utility_minimums_json,
         buff_minimums_json = excluded.buff_minimums_json,
         manual_override_ids_json = excluded.manual_override_ids_json,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(
      name,
      JSON.stringify(settings),
      JSON.stringify([...utilityMinimums.entries()]),
      JSON.stringify([...buffMinimums.entries()]),
      JSON.stringify([...manualOverrideIds]),
      userId,
      userId
    )
    .run();
  const loadout = await db.prepare('SELECT id FROM raid_comp_loadouts WHERE name = ?').bind(name).first<{ id: number }>();
  if (!loadout) throw new Error('Could not save the loadout.');
  await db.batch([
    db.prepare('DELETE FROM raid_comp_loadout_assignments WHERE loadout_id = ?').bind(loadout.id),
    ...[...assignments.entries()].map(([charId, group]) =>
      db
        .prepare('INSERT INTO raid_comp_loadout_assignments (loadout_id, blizzard_char_id, raid_group) VALUES (?, ?, ?)')
        .bind(loadout.id, charId, group)
    ),
  ]);
}

/** Restores an exact saved board/settings snapshot; it intentionally does not run automatic regeneration. */
export async function loadRaidCompLoadout(dbInput: D1Database | undefined, loadoutId: number, userId: number): Promise<string> {
  const db = getDatabase(dbInput);
  const loadout = await db
    .prepare('SELECT name, settings_json, utility_minimums_json, buff_minimums_json, manual_override_ids_json FROM raid_comp_loadouts WHERE id = ?')
    .bind(loadoutId)
    .first<{ name: string; settings_json: string; utility_minimums_json: string; buff_minimums_json: string; manual_override_ids_json: string }>();
  if (!loadout) throw new Error('Saved loadout not found.');
  const settings = parseLoadoutSettings(loadout.settings_json);
  const utilityMinimums = parseLoadoutUtilityMinimums(loadout.utility_minimums_json);
  const buffMinimums = parseLoadoutBuffMinimums(loadout.buff_minimums_json);
  const manualOverrideIds = parseLoadoutManualOverrideIds(loadout.manual_override_ids_json);
  const assignmentResult = await db
    .prepare('SELECT blizzard_char_id, raid_group FROM raid_comp_loadout_assignments WHERE loadout_id = ?')
    .bind(loadoutId)
    .all<{ blizzard_char_id: number; raid_group: number }>();
  const assignments = assignmentResult.results ?? [];
  await db.batch([
    writeRaidCompSettings(db, settings, userId),
    db.prepare('DELETE FROM raid_comp_utility_minimums'),
    ...utilityMinimums.map(([utility, minimum]) =>
      db
        .prepare('INSERT INTO raid_comp_utility_minimums (utility_name, minimum_count, updated_by_user_id, updated_at) VALUES (?, ?, ?, unixepoch())')
        .bind(utility, minimum, userId)
    ),
    db.prepare('DELETE FROM raid_comp_buff_minimums'),
    ...buffMinimums.map(([buff, minimum]) =>
      db
        .prepare('INSERT INTO raid_comp_buff_minimums (buff_name, minimum_count, updated_by_user_id, updated_at) VALUES (?, ?, ?, unixepoch())')
        .bind(buff, minimum, userId)
    ),
    db.prepare('DELETE FROM raid_comp_assignments'),
    ...assignments.map((assignment) =>
      db
        .prepare('INSERT INTO raid_comp_assignments (blizzard_char_id, raid_group, updated_by_user_id, updated_at) VALUES (?, ?, ?, unixepoch())')
        .bind(assignment.blizzard_char_id, assignment.raid_group, userId)
    ),
    db.prepare('DELETE FROM raid_comp_manual_overrides'),
    ...manualOverrideIds.map((charId) =>
      db
        .prepare('INSERT INTO raid_comp_manual_overrides (blizzard_char_id, updated_by_user_id, updated_at) VALUES (?, ?, unixepoch())')
        .bind(charId, userId)
    ),
  ]);
  return loadout.name;
}

export async function deleteRaidCompLoadout(dbInput: D1Database | undefined, loadoutId: number): Promise<void> {
  await getDatabase(dbInput).prepare('DELETE FROM raid_comp_loadouts WHERE id = ?').bind(loadoutId).run();
}

/** Renames a saved snapshot without changing its captured board or settings. */
export async function renameRaidCompLoadout(
  dbInput: D1Database | undefined,
  loadoutId: number,
  rawName: string,
  userId: number
): Promise<void> {
  const name = rawName.trim();
  if (name.length < 1 || name.length > 80) throw new Error('Loadout names must be between 1 and 80 characters.');
  const result = await getDatabase(dbInput)
    .prepare('UPDATE raid_comp_loadouts SET name = ?, updated_by_user_id = ?, updated_at = unixepoch() WHERE id = ?')
    .bind(name, userId, loadoutId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) throw new Error('Saved loadout not found.');
}

/** Temporary PUG/trial candidates are deliberately separate from ingested Blizzard characters. */
export async function getTempRaidCompCandidates(dbInput?: D1Database): Promise<TempRaidCompCandidate[]> {
  const db = getDatabase(dbInput);
  const result = await db
    .prepare('SELECT id, name, class_name, assigned_role FROM raid_comp_temp_candidates ORDER BY created_at, id')
    .all<{ id: number; name: string; class_name: string; assigned_role: AssignedRole }>();
  return (result.results ?? []).map((row) => ({ id: Number(row.id), name: row.name, className: row.class_name, assignedRole: row.assigned_role }));
}

export async function isTempRaidCompCandidate(dbInput: D1Database | undefined, id: number): Promise<boolean> {
  const row = await getDatabase(dbInput).prepare('SELECT 1 AS found FROM raid_comp_temp_candidates WHERE id = ?').bind(id).first<{ found: number }>();
  return Boolean(row?.found);
}

export async function createTempRaidCompCandidate(
  dbInput: D1Database | undefined,
  candidate: Omit<TempRaidCompCandidate, 'id'>,
  userId: number
): Promise<void> {
  await getDatabase(dbInput)
    .prepare('INSERT INTO raid_comp_temp_candidates (name, class_name, assigned_role, created_by_user_id) VALUES (?, ?, ?, ?)')
    .bind(candidate.name, candidate.className, candidate.assignedRole, userId)
    .run();
}

export async function deleteTempRaidCompCandidate(dbInput: D1Database | undefined, id: number): Promise<void> {
  const db = getDatabase(dbInput);
  await db.batch([
    db.prepare('DELETE FROM raid_comp_assignments WHERE blizzard_char_id = ?').bind(-id),
    db.prepare('DELETE FROM raid_comp_manual_overrides WHERE blizzard_char_id = ?').bind(-id),
    db.prepare('DELETE FROM raid_comp_temp_candidates WHERE id = ?').bind(id),
  ]);
}

export class RaidCompGroupFullError extends Error {
  constructor(group: number) {
    super(`Group ${group} is already full (${MAX_GROUP_SIZE}/${MAX_GROUP_SIZE}).`);
  }
}

export async function setRaidCompAssignment(
  dbInput: D1Database | undefined,
  blizzardCharId: number,
  group: number | null,
  userId: number
): Promise<void> {
  const db = getDatabase(dbInput);
  if (!group) {
    await db.batch([
      db.prepare('DELETE FROM raid_comp_assignments WHERE blizzard_char_id = ?').bind(blizzardCharId),
      db
        .prepare('INSERT INTO raid_comp_manual_overrides (blizzard_char_id, updated_by_user_id, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(blizzard_char_id) DO UPDATE SET updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at')
        .bind(blizzardCharId, userId),
    ]);
    return;
  }
  // Re-checked here (not just client-side) so two officers dragging at once can't overfill a group.
  const occupied = await db
    .prepare('SELECT COUNT(*) AS count FROM raid_comp_assignments WHERE raid_group = ? AND blizzard_char_id != ?')
    .bind(group, blizzardCharId)
    .first<{ count: number }>();
  if (Number(occupied?.count ?? 0) >= MAX_GROUP_SIZE) throw new RaidCompGroupFullError(group);

  await db.batch([
    db.prepare(
      `INSERT INTO raid_comp_assignments (blizzard_char_id, raid_group, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(blizzard_char_id) DO UPDATE SET
         raid_group = excluded.raid_group,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`
    )
    .bind(blizzardCharId, group, userId),
    db
      .prepare('INSERT INTO raid_comp_manual_overrides (blizzard_char_id, updated_by_user_id, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(blizzard_char_id) DO UPDATE SET updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at')
      .bind(blizzardCharId, userId),
  ]);
}

/** Atomically exchange two raiders' group/bench placements. `null` means Bench. */
export async function swapRaidCompAssignments(
  dbInput: D1Database | undefined,
  firstCharId: number,
  secondCharId: number,
  userId: number
): Promise<void> {
  if (firstCharId === secondCharId) return;
  const db = getDatabase(dbInput);
  const existing = await db
    .prepare('SELECT blizzard_char_id, raid_group FROM raid_comp_assignments WHERE blizzard_char_id IN (?, ?)')
    .bind(firstCharId, secondCharId)
    .all<{ blizzard_char_id: number; raid_group: number }>();
  const groups = new Map((existing.results ?? []).map((row) => [Number(row.blizzard_char_id), Number(row.raid_group)]));
  const firstGroup = groups.get(firstCharId) ?? null;
  const secondGroup = groups.get(secondCharId) ?? null;
  if (firstGroup === secondGroup) return;

  const writePlacement = (charId: number, group: number | null) =>
    group === null
      ? db.prepare('DELETE FROM raid_comp_assignments WHERE blizzard_char_id = ?').bind(charId)
      : db
          .prepare(
            `INSERT INTO raid_comp_assignments (blizzard_char_id, raid_group, updated_by_user_id, updated_at)
             VALUES (?, ?, ?, unixepoch())
             ON CONFLICT(blizzard_char_id) DO UPDATE SET
               raid_group = excluded.raid_group,
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = excluded.updated_at`
          )
          .bind(charId, group, userId);
  // A swap preserves every group's final population, including when one side is the Bench.
  const markManual = (charId: number) =>
    db
      .prepare('INSERT INTO raid_comp_manual_overrides (blizzard_char_id, updated_by_user_id, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(blizzard_char_id) DO UPDATE SET updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at')
      .bind(charId, userId);
  await db.batch([writePlacement(firstCharId, secondGroup), writePlacement(secondCharId, firstGroup), markManual(firstCharId), markManual(secondCharId)]);
}

/** Saves the given settings, then rebuilds and persists the whole board from Bench's current priority order. */
export async function regenerateRaidComp(dbInput: D1Database | undefined, settings: RaidCompSettings, userId: number): Promise<void> {
  const db = getDatabase(dbInput);
  const [bench, utilityMinimums, buffMinimums] = await Promise.all([getBenchData(db), getUtilityMinimums(db), getBuffMinimums(db)]);
  const priorityOrder = rankByPriority(bench.ranked, settings);
  const assignments = buildAssignments(priorityOrder, settings, utilityMinimums, buffMinimums);

  const statements = [
    db
      .prepare(
        `INSERT INTO raid_comp_settings (
           id, tank_quota, healer_quota, dps_quota, melee_dps_quota, ranged_dps_quota, weight, parse_weight, death_weight, vault_weight, preparedness_weight, upgrades_weight,
           scale, updated_by_user_id, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           tank_quota = excluded.tank_quota,
           healer_quota = excluded.healer_quota,
           dps_quota = excluded.dps_quota,
           melee_dps_quota = excluded.melee_dps_quota,
           ranged_dps_quota = excluded.ranged_dps_quota,
           parse_weight = excluded.parse_weight,
           death_weight = excluded.death_weight,
           vault_weight = excluded.vault_weight,
           preparedness_weight = excluded.preparedness_weight,
           upgrades_weight = excluded.upgrades_weight,
           scale = excluded.scale,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = excluded.updated_at`
      )
      .bind(
        settings.tankQuota,
        settings.healerQuota,
        settings.meleeDpsQuota + settings.rangedDpsQuota,
        settings.meleeDpsQuota,
        settings.rangedDpsQuota,
        settings.parseWeight,
        settings.parseWeight,
        settings.deathWeight,
        settings.vaultWeight,
        settings.preparednessWeight,
        settings.upgradesWeight,
        settings.scale,
        userId
    ),
    db.prepare('DELETE FROM raid_comp_assignments'),
    db.prepare('DELETE FROM raid_comp_manual_overrides'),
    ...[...assignments.entries()].map(([charId, group]) =>
      db
        .prepare(
          `INSERT INTO raid_comp_assignments (blizzard_char_id, raid_group, updated_by_user_id, updated_at)
           VALUES (?, ?, ?, unixepoch())`
        )
        .bind(charId, group, userId)
    ),
  ];
  await db.batch(statements);
}
