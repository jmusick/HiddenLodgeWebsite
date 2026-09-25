import type { D1Database } from '@cloudflare/workers-types';
import { getDeathAnalysisNights, requireAccessToken } from './death-analysis';
import { WclRateLimitError, applyWclRateLimitBackoff, getWclBackoffUntil, queryWcl } from './wcl';

export const ULATEK_ENCOUNTER_ID = 3492;
// Fury Unleashed lands at 9:58.7 and Berserk at 10:15.9 in guild logs.
export const GROUP_SIZE_DEADLINE_SECONDS = 600;
const BOSS_TARGET_NAMES = new Set(["Ula'tek", 'Venomous Heart', 'Gore Rattle']);
const VENOMOUS_HEART_AURA_ID = 1299526;
const SNAPSHOT_VERSION = 3;

// Heroic Ula'tek runs on a fixed clock: the Venomous Heart aura marks each 20s
// burn and stage changes land at the same second on every pull. Each weight is
// the segment's median raid boss DPS relative to Stage 1, measured from 21 guild
// pulls of 7:39 or longer (Sep 19-25, 2026). Burn 3 and the final seconds come
// from the 3 pulls that reached them; Stage 3 uses the pulls that reached Burn 3.
export const ULATEK_TIMELINE = [
  { key: 'stage1', label: 'Stage 1', start: 0, weight: 1 },
  { key: 'burn1', label: 'Heart burn 1', start: 135.4, weight: 5.8 },
  { key: 'stage2', label: 'Stage 2 (adds)', start: 155.4, weight: 0.04 },
  { key: 'burn2', label: 'Heart burn 2', start: 284.4, weight: 4.0 },
  { key: 'intermission', label: 'Intermission', start: 304.4, weight: 0.06 },
  { key: 'stage3', label: 'Stage 3', start: 362.5, weight: 0.64 },
  { key: 'burn3', label: 'Heart burn 3', start: 573.6, weight: 1.9 },
  { key: 'final', label: 'Final seconds', start: 593.6, weight: 0.1 },
] as const;
const FIRST_BURN_START = 135.4;

export type PullRole = 'tank' | 'healer' | 'dps';
export interface PullPlayer {
  guid: number;
  name: string;
  role: PullRole;
  bossDamage: number;
  // Shared-health target damage in each ULATEK_TIMELINE segment.
  segmentDamage: number[];
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
  snapshotVersion: number;
  // Seconds the pull's clock runs ahead (+) or behind (-) the standard timeline,
  // from the first Venomous Heart burn.
  timelineOffsetSeconds: number;
  // Shared-health target damage in each ULATEK_TIMELINE segment.
  segmentDamage: number[];
}
export interface PullPlayerStage {
  // Boss DPS over the part of the stage the pull reached; null if not reached.
  dps: number | null;
  // DPS players only: the pace target scaled by the stage's weight.
  target: number | null;
  meetsTarget: boolean | null;
}
export interface PullPlayerResult extends PullPlayer {
  bossDps: number;
  paceDps: number;
  meetsMinimum: boolean | null;
  stages: PullPlayerStage[];
}
export interface PullSegmentResult {
  key: string;
  label: string;
  start: number;
  end: number;
  weight: number;
  elapsedSeconds: number;
  damage: number;
  // Damage this segment needs at the required pace, over its full length.
  requiredDamage: number | null;
}
export interface PullAnalysis extends PullSnapshot {
  groupSize: number;
  tanks: number;
  healers: number;
  damageDealers: number;
  inferredBossHealth: number | null;
  weightedSecondsElapsed: number;
  weightedSecondsToDeadline: number;
  paceDps: number;
  requiredPaceDps: number | null;
  paceRatio: number | null;
  projectedKillSeconds: number | null;
  projectedRemainingPercent: number | null;
  requiredPaceDpsPerDamageDealer: number | null;
  rolePaceDps: number;
  playersWithMinimum: number | null;
  segments: PullSegmentResult[];
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

interface TimelineSegment { key: string; label: string; start: number; end: number; weight: number }

// The standard timeline shifted by the pull's offset. The final segment runs to
// the deadline, or past it for pulls that outlived the enrage.
function timelineFor(offsetSeconds: number, durationSeconds: number): TimelineSegment[] {
  return ULATEK_TIMELINE.map((segment, index) => {
    const next = ULATEK_TIMELINE[index + 1];
    return {
      key: segment.key, label: segment.label, weight: segment.weight,
      start: index === 0 ? 0 : segment.start + offsetSeconds,
      end: next ? next.start + offsetSeconds : Math.max(GROUP_SIZE_DEADLINE_SECONDS, durationSeconds),
    };
  });
}

// Stage 1-equivalent seconds: each second counts at its segment's typical weight.
function weightedSeconds(timeline: TimelineSegment[], untilSeconds: number): number {
  return timeline.reduce((sum, segment) =>
    sum + segment.weight * Math.max(0, Math.min(untilSeconds, segment.end) - segment.start), 0);
}

// Walks the rest of the timeline at the pull's pace; null if the boss outlives the enrage.
function projectKillSeconds(timeline: TimelineSegment[], fromSeconds: number, remainingDamage: number, paceDps: number): number | null {
  let left = remainingDamage;
  for (const segment of timeline) {
    const from = Math.max(segment.start, fromSeconds);
    const to = Math.min(segment.end, GROUP_SIZE_DEADLINE_SECONDS);
    if (to <= from) continue;
    const rate = paceDps * segment.weight;
    if (rate * (to - from) >= left) return from + left / rate;
    left -= rate * (to - from);
  }
  return null;
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
  const timeline = timelineFor(snapshot.timelineOffsetSeconds, duration);
  const weightedSecondsElapsed = Math.max(1, weightedSeconds(timeline, duration));
  const weightedSecondsToDeadline = weightedSeconds(timeline, GROUP_SIZE_DEADLINE_SECONDS);
  const paceDps = snapshot.raidBossDamage / weightedSecondsElapsed;
  const requiredPaceDps = inferredBossHealth === null ? null : inferredBossHealth / weightedSecondsToDeadline;
  const remainingDamage = inferredBossHealth === null ? null : Math.max(0, inferredBossHealth - snapshot.raidBossDamage);
  const projectedKillSeconds = snapshot.isKill || remainingDamage === null || paceDps <= 0 || duration >= GROUP_SIZE_DEADLINE_SECONDS
    ? null : projectKillSeconds(timeline, duration, remainingDamage, paceDps);
  const projectedRemainingPercent = snapshot.isKill || inferredBossHealth === null ? null
    : duration >= GROUP_SIZE_DEADLINE_SECONDS ? snapshot.bossRemainingPercent
    : Math.max(0, 100 * (1 - (snapshot.raidBossDamage + paceDps * (weightedSecondsToDeadline - weightedSecondsElapsed)) / inferredBossHealth));
  const rolePaceDps = snapshot.players
    .filter((player) => player.role !== 'dps')
    .reduce((sum, player) => sum + player.bossDamage / weightedSecondsElapsed, 0);
  const requiredPaceDpsPerDamageDealer = requiredPaceDps !== null && damageDealers > 0
    ? Math.max(0, (requiredPaceDps - rolePaceDps) / damageDealers) : null;
  const segments = timeline.map((segment, index) => {
    const end = Math.min(segment.end, Math.max(GROUP_SIZE_DEADLINE_SECONDS, duration));
    return {
      ...segment, end,
      elapsedSeconds: Math.max(0, Math.min(duration, end) - segment.start),
      damage: snapshot.segmentDamage[index] ?? 0,
      requiredDamage: requiredPaceDps === null ? null
        : requiredPaceDps * segment.weight * Math.max(0, Math.min(end, GROUP_SIZE_DEADLINE_SECONDS) - segment.start),
    };
  });
  const players = snapshot.players.map((player) => {
    const paceDps = player.bossDamage / weightedSecondsElapsed;
    const isDps = player.role === 'dps' && requiredPaceDpsPerDamageDealer !== null;
    const stages = segments.map((segment, index) => {
      if (segment.elapsedSeconds < 1) return { dps: null, target: null, meetsTarget: null };
      const dps = (player.segmentDamage?.[index] ?? 0) / segment.elapsedSeconds;
      const target = isDps ? requiredPaceDpsPerDamageDealer * segment.weight : null;
      return { dps, target, meetsTarget: target === null ? null : dps >= target };
    });
    return { ...player, bossDps: player.bossDamage / duration, paceDps, stages,
      meetsMinimum: isDps ? paceDps >= requiredPaceDpsPerDamageDealer : null };
  });
  return {
    ...snapshot, groupSize, tanks, healers, damageDealers,
    inferredBossHealth, weightedSecondsElapsed, weightedSecondsToDeadline,
    paceDps, requiredPaceDps, paceRatio: requiredPaceDps ? paceDps / requiredPaceDps : null,
    projectedKillSeconds, projectedRemainingPercent, requiredPaceDpsPerDamageDealer, rolePaceDps,
    playersWithMinimum: requiredPaceDpsPerDamageDealer === null ? null : players.filter((player) => player.meetsMinimum === true).length,
    segments, players,
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
      burns?: unknown;
    } | null };
  }>(token, `query GroupSizePull($code: String!) {
    reportData { report(code: $code) {
      startTime
      fights(fightIDs: [${fightId}]) { id startTime endTime encounterID difficulty kill bossPercentage enemyNPCs { id } }
      masterData { actors(type: "NPC") { id name } }
      playerDetails(fightIDs: [${fightId}])
      burns: table(dataType: Buffs, hostilityType: Enemies, fightIDs: [${fightId}], abilityID: ${VENOMOUS_HEART_AURA_ID})
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
    ...roles.tank.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'tank' as const, bossDamage: 0, segmentDamage: [] as number[] })),
    ...roles.healer.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'healer' as const, bossDamage: 0, segmentDamage: [] as number[] })),
    ...roles.dps.map((player) => ({ guid: Number(player.guid), name: player.name ?? '', role: 'dps' as const, bossDamage: 0, segmentDamage: [] as number[] })),
  ].filter((player) => Number.isInteger(player.guid) && player.guid > 0);
  if (players.length === 0) throw new Error('No players were found in this pull.');

  // A pull's clock can run a second or two off; align the timeline to its first burn.
  const fightStart = Number(fight.startTime ?? 0);
  const fightEnd = Number(fight.endTime ?? 0);
  const firstBurn = (report.burns as { data?: { auras?: Array<{ bands?: Array<{ startTime?: number }> }> } } | null)
    ?.data?.auras?.[0]?.bands?.[0]?.startTime;
  const measuredOffset = firstBurn === undefined ? 0 : (Number(firstBurn) - fightStart) / 1000 - FIRST_BURN_START;
  const timelineOffsetSeconds = Number.isFinite(measuredOffset) && Math.abs(measuredOffset) <= 10 ? measuredOffset : 0;
  const timeline = timelineFor(timelineOffsetSeconds, (fightEnd - fightStart) / 1000);

  const tableFields = [
    ...targets.map((target, index) =>
      `t${index}: table(dataType: DamageDone, fightIDs: [${fightId}], targetID: ${target.id})`),
    // Per-player damage to the shared-health targets in each segment.
    ...timeline.map((segment, index) => {
      const start = fightStart + Math.round(segment.start * 1000);
      const end = Math.min(fightEnd, fightStart + Math.round(segment.end * 1000));
      return end > start
        ? `s${index}: table(dataType: DamageDone, fightIDs: [${fightId}], startTime: ${start}, endTime: ${end}, filterExpression: $targets)`
        : '';
    }),
  ].filter(Boolean).join('\n');
  const tableData = await queryWcl<{ reportData?: { report?: Record<string, unknown> | null } }>(token,
    `query GroupSizeTargets($code: String!, $targets: String!) { reportData { report(code: $code) { ${tableFields} } } }`,
    // WCL's filter syntax matches target.name; target.id returns nothing.
    { code: reportCode, targets: [...BOSS_TARGET_NAMES].map((name) => `target.name = ${JSON.stringify(name)}`).join(' or ') });
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
  for (const player of players) player.segmentDamage = timeline.map(() => 0);
  const segmentDamage = timeline.map((_segment, index) => {
    let total = 0;
    for (const entry of entries(tableData?.reportData?.report?.[`s${index}`])) {
      const damage = Number(entry.total ?? 0);
      if (!Number.isFinite(damage) || damage < 0) continue;
      total += damage;
      const player = byGuid.get(Number(entry.guid));
      if (player) player.segmentDamage[index] += damage;
    }
    return total;
  });
  return {
    reportCode, fightId,
    startedUtc: Math.floor((Number(report.startTime ?? 0) + Number(fight.startTime ?? 0)) / 1000),
    durationSeconds: (fightEnd - fightStart) / 1000,
    isKill: fight.kill === true,
    bossRemainingPercent: fight.kill ? 0 : Number(fight.bossPercentage ?? 100),
    bossTargets: targets.map((target) => target.name ?? ''),
    players, raidBossDamage,
    snapshotVersion: SNAPSHOT_VERSION, timelineOffsetSeconds, segmentDamage,
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
    try {
      const snapshot = JSON.parse(cached.payload_json) as PullSnapshot;
      // Snapshots from before the stage timeline lack segment damage; refetch those.
      if (snapshot.snapshotVersion === SNAPSHOT_VERSION) return analyzePull(snapshot);
    } catch { /* Refetch corrupt cache. */ }
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
