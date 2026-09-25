import type { D1Database } from '@cloudflare/workers-types';
import { getDeathAnalysisNights, requireAccessToken } from './death-analysis';
import { WclRateLimitError, applyWclRateLimitBackoff, getWclBackoffUntil, queryWcl } from './wcl';

export const ULATEK_ENCOUNTER_ID = 3492;
export const GROUP_SIZE_DEADLINE_SECONDS = 600; // Planning benchmark, not a verified encounter enrage.
const BOSS_TARGET_NAMES = new Set(["Ula'tek", 'Venomous Heart', 'Gore Rattle']);

export type PullRole = 'tank' | 'healer' | 'dps';
export interface PullPlayer {
  guid: number;
  name: string;
  role: PullRole;
  bossDamage: number;
}
export interface PullSnapshot {
  reportCode: string;
  fightId: number;
  startedUtc: number;
  durationSeconds: number;
  isKill: boolean;
  bossRemainingPercent: number;
  bossTargets: string[];
  players: PullPlayer[];
  raidBossDamage: number;
}
export interface PullPlayerResult extends PullPlayer {
  bossDps: number;
  meetsMinimum: boolean | null;
}
export interface PullAnalysis extends PullSnapshot {
  groupSize: number;
  tanks: number;
  healers: number;
  damageDealers: number;
  inferredBossHealth: number | null;
  observedProgressDamage: number | null;
  projectedKillSeconds: number | null;
  projectedSecondsFromDeadline: number | null;
  projectedRemainingPercent: number | null;
  requiredDpsPerDamageDealer: number | null;
  roleBossDps: number;
  playersWithMinimum: number | null;
  players: PullPlayerResult[];
}

interface WclFight {
  id?: number;
  startTime?: number;
  endTime?: number;
  encounterID?: number;
  difficulty?: number;
  kill?: boolean;
  bossPercentage?: number | null;
  enemyNPCs?: Array<{ id?: number }>;
}
interface WclPlayer { guid?: number; name?: string }
interface WclTableEntry { guid?: number; total?: number }
interface WclTable { data?: { entries?: WclTableEntry[] } }

function entries(value: unknown): WclTableEntry[] {
  const list = (value as WclTable | null)?.data?.entries;
  return Array.isArray(list) ? list : [];
}
function playersByRole(value: unknown): Record<PullRole, WclPlayer[]> {
  const data = (value as { data?: { playerDetails?: { tanks?: WclPlayer[]; healers?: WclPlayer[]; dps?: WclPlayer[] } } } | null)?.data?.playerDetails;
  return { tank: data?.tanks ?? [], healer: data?.healers ?? [], dps: data?.dps ?? [] };
}

export function analyzePull(snapshot: PullSnapshot): PullAnalysis {
  const groupSize = snapshot.players.length;
  const tanks = snapshot.players.filter((player) => player.role === 'tank').length;
  const healers = snapshot.players.filter((player) => player.role === 'healer').length;
  const damageDealers = snapshot.players.filter((player) => player.role === 'dps').length;
  // WCL provides the remaining percentage but not maximum boss HP. Very short
  // wipes (<5% progress) cannot support a stable estimate from that percentage.
  const progressFraction = snapshot.isKill ? 1 : 1 - snapshot.bossRemainingPercent / 100;
  const estimate = progressFraction > 0.05 && progressFraction <= 1
    ? snapshot.raidBossDamage / progressFraction : null;
  const inferredBossHealth = estimate !== null && Number.isFinite(estimate) && estimate > 0 ? estimate : null;
  const duration = Math.max(1, snapshot.durationSeconds);
  const observedProgressDamage = inferredBossHealth === null ? null : inferredBossHealth * progressFraction;
  const observedRaidDps = observedProgressDamage === null ? null : observedProgressDamage / duration;
  const projectedKillSeconds = inferredBossHealth !== null && observedRaidDps !== null && observedRaidDps > 0
    ? inferredBossHealth / observedRaidDps : null;
  const projectedRemainingPercent = inferredBossHealth !== null && observedRaidDps !== null && observedRaidDps > 0
    ? Math.max(0, 100 * (1 - observedRaidDps * GROUP_SIZE_DEADLINE_SECONDS / inferredBossHealth)) : null;
  const roleBossDps = snapshot.players
    .filter((player) => player.role !== 'dps')
    .reduce((sum, player) => sum + player.bossDamage / duration, 0);
  const requiredDpsPerDamageDealer = inferredBossHealth !== null && damageDealers > 0
    ? Math.max(0, (inferredBossHealth / GROUP_SIZE_DEADLINE_SECONDS - roleBossDps) / damageDealers) : null;
  const players = snapshot.players.map((player) => {
    const bossDps = player.bossDamage / duration;
    return { ...player, bossDps,
      meetsMinimum: player.role === 'dps' && requiredDpsPerDamageDealer !== null
        ? bossDps >= requiredDpsPerDamageDealer : null };
  });
  return {
    ...snapshot, groupSize, tanks, healers, damageDealers,
    inferredBossHealth,
    observedProgressDamage, projectedKillSeconds,
    projectedSecondsFromDeadline: projectedKillSeconds === null ? null : projectedKillSeconds - GROUP_SIZE_DEADLINE_SECONDS,
    projectedRemainingPercent, requiredDpsPerDamageDealer, roleBossDps,
    playersWithMinimum: requiredDpsPerDamageDealer === null ? null : players.filter((player) => player.meetsMinimum === true).length,
    players,
  };
}

async function fetchPullFromWcl(db: D1Database, reportCode: string, fightId: number): Promise<PullSnapshot> {
  const token = await requireAccessToken(db);
  const metadata = await queryWcl<{
    reportData?: { report?: {
      startTime?: number;
      fights?: WclFight[];
      masterData?: { actors?: Array<{ id?: number; name?: string }> };
      playerDetails?: unknown;
    } | null };
  }>(token, `query GroupSizePull($code: String!) {
    reportData { report(code: $code) {
      startTime
      fights(fightIDs: [${fightId}]) { id startTime endTime encounterID difficulty kill bossPercentage enemyNPCs { id } }
      masterData { actors(type: "NPC") { id name } }
      playerDetails(fightIDs: [${fightId}])
    } }
  }`, { code: reportCode });
  const report = metadata?.reportData?.report;
  const fight = report?.fights?.find((row) => row.id === fightId);
  if (!report || !fight || fight.encounterID !== ULATEK_ENCOUNTER_ID || fight.difficulty !== 4) {
    throw new Error('This is not a Heroic Ula’tek pull.');
  }
  const activeNpcIds = new Set((fight.enemyNPCs ?? []).map((npc) => Number(npc.id)));
  const targets = (report.masterData?.actors ?? []).filter((actor) =>
    BOSS_TARGET_NAMES.has(actor.name ?? '') && Number.isInteger(actor.id) && activeNpcIds.has(Number(actor.id))
  );
  if (targets.length === 0) throw new Error('No shared-health boss targets were found in this pull.');
  const roles = playersByRole(report.playerDetails);
  const players: PullPlayer[] = [
    ...roles.tank.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'tank' as const, bossDamage: 0 })),
    ...roles.healer.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'healer' as const, bossDamage: 0 })),
    ...roles.dps.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'dps' as const, bossDamage: 0 })),
  ].filter((player) => Number.isInteger(player.guid) && player.guid > 0);
  if (players.length === 0) throw new Error('No players were found in this pull.');

  const tableFields = targets.map((target, index) =>
    `t${index}: table(dataType: DamageDone, fightIDs: [${fightId}], targetID: ${target.id})`
  ).join('\n');
  const tableData = await queryWcl<{ reportData?: { report?: Record<string, unknown> | null } }>(token,
    `query GroupSizeTargets($code: String!) { reportData { report(code: $code) { ${tableFields} } } }`,
    { code: reportCode });
  const byGuid = new Map(players.map((player) => [player.guid, player]));
  let raidBossDamage = 0;
  targets.forEach((_target, index) => {
    for (const entry of entries(tableData?.reportData?.report?.[`t${index}`])) {
      const damage = Number(entry.total ?? 0);
      if (!Number.isFinite(damage) || damage < 0) continue;
      raidBossDamage += damage;
      const player = byGuid.get(Number(entry.guid));
      if (player) player.bossDamage += damage;
    }
  });
  if (raidBossDamage <= 0) throw new Error('No boss-only damage was found in this pull.');
  return {
    reportCode, fightId,
    startedUtc: Math.floor((Number(report.startTime ?? 0) + Number(fight.startTime ?? 0)) / 1000),
    durationSeconds: (Number(fight.endTime ?? 0) - Number(fight.startTime ?? 0)) / 1000,
    isKill: fight.kill === true,
    bossRemainingPercent: fight.kill ? 0 : Number(fight.bossPercentage ?? 100),
    bossTargets: targets.map((target) => target.name ?? ''),
    players, raidBossDamage,
  };
}

export async function getGroupSizePull(db: D1Database, reportCode: string, fightId: number): Promise<PullAnalysis | null> {
  const nights = await getDeathAnalysisNights(db);
  const canonical = nights.find((night) => night.canonical?.code === reportCode)?.canonical;
  if (!canonical) return null;
  const row = await db.prepare(
    'SELECT 1 FROM pull_score_pulls WHERE report_code = ? AND fight_id = ? AND encounter_id = ? AND difficulty = 4 LIMIT 1'
  ).bind(reportCode, fightId, ULATEK_ENCOUNTER_ID).first();
  if (!row) return null;
  const cached = await db.prepare(
    'SELECT source_synced_at, payload_json FROM group_size_pull_cache WHERE report_code = ? AND fight_id = ?'
  ).bind(reportCode, fightId).first<{ source_synced_at: number; payload_json: string }>();
  if (cached && cached.source_synced_at >= canonical.syncedAt) {
    try { return analyzePull(JSON.parse(cached.payload_json) as PullSnapshot); } catch { /* Refetch corrupt cache. */ }
  }
  const backoffUntil = await getWclBackoffUntil(db);
  if (backoffUntil && backoffUntil > Math.floor(Date.now() / 1000)) throw new Error('Warcraft Logs is temporarily rate limited. Try again later.');
  let snapshot: PullSnapshot;
  try {
    snapshot = await fetchPullFromWcl(db, reportCode, fightId);
  } catch (error) {
    if (error instanceof WclRateLimitError) await applyWclRateLimitBackoff(db, error);
    throw error;
  }
  await db.prepare(
    `INSERT INTO group_size_pull_cache (report_code, fight_id, source_synced_at, payload_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(report_code, fight_id) DO UPDATE SET
       source_synced_at = excluded.source_synced_at,
       payload_json = excluded.payload_json,
       fetched_at = unixepoch()`
  ).bind(reportCode, fightId, canonical.syncedAt, JSON.stringify(snapshot)).run();
  return analyzePull(snapshot);
}
