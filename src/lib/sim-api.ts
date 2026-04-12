import type { D1Database } from '@cloudflare/workers-types';

export type SimDifficulty = 'mythic' | 'heroic' | 'unknown';

export interface SimTargetRaider {
  blizzard_char_id: number;
  name: string;
  realm_slug: string;
  region: 'us';
  level: number;
  guild_rank: number;
  priority: number | null;
}

export interface SimTargetTeam {
  team_id: number;
  team_name: string;
  raid_mode: string;
  difficulty: SimDifficulty;
  raiders: SimTargetRaider[];
}

export interface SimTargetsResponse {
  roster_revision: string;
  generated_at_utc: string;
  teams: SimTargetTeam[];
}

interface RawTargetRow {
  team_id: number;
  team_name: string;
  raid_mode: string;
  blizzard_char_id: number;
  name: string;
  realm_slug: string;
  level: number;
  rank: number;
}

export interface SimRaiderSummaryInput {
  blizzard_char_id: number;
  baseline_dps?: number | null;
  top_scenario?: string | null;
  top_dps?: number | null;
  gain_dps?: number | null;
}

export interface SimItemWinnerInput {
  slot: string;
  item_id?: number | null;
  item_label?: string | null;
  ilvl?: number | null;
  source?: string | null;
  best_blizzard_char_id?: number | null;
  delta_dps?: number | null;
  pct_gain?: number | null;
  simc?: string | null;
}

export interface SimItemScoreInput {
  blizzard_char_id: number;
  slot: string;
  item_id?: number | null;
  item_label?: string | null;
  ilvl?: number | null;
  source?: string | null;
  delta_dps?: number | null;
  pct_gain?: number | null;
  simc?: string | null;
}

export interface SimResultsInput {
  run_id: string;
  roster_revision?: string | null;
  started_at_utc?: string | null;
  finished_at_utc?: string | null;
  site_team_id: number;
  difficulty?: string | null;
  simc_version?: string | null;
  runner_version?: string | null;
  raider_summaries: SimRaiderSummaryInput[];
  item_winners: SimItemWinnerInput[];
  item_scores?: SimItemScoreInput[];
}

export interface InsertSimResultsResult {
  success: boolean;
  duplicate: boolean;
  run_id: string;
  site_team_id: number;
  inserted?: {
    raider_summaries: number;
    item_winners: number;
  };
}

export interface PurgeSimHistoryResult {
  deleted_runs: number;
  deleted_raider_summaries: number;
  deleted_item_winners: number;
}

export interface PurgeAllSimHistoryResult extends PurgeSimHistoryResult {}

export interface LifecycleInput {
  run_id: string;
  site_team_id: number;
  roster_revision?: string | null;
  difficulty?: string | null;
  status?: 'running' | 'finished' | 'failed';
  started_at_utc?: string | null;
  finished_at_utc?: string | null;
  error_message?: string | null;
  runner_version?: string | null;
}

export interface RaiderSimWinner {
  slot: string;
  item_id: number | null;
  item_label: string | null;
  ilvl: number | null;
  source: string | null;
  delta_dps: number | null;
  pct_gain: number | null;
  simc: string | null;
}

export interface RaiderSimRecommendations {
  run_id: string;
  site_team_id: number;
  difficulty: string;
  finished_at_utc: string | null;
  updated_at: number;
  winners: RaiderSimWinner[];
}

export interface SimLatestRunIndicator {
  run_id: string;
  site_team_id: number;
  difficulty: string;
  status: string;
  finished_at_utc: string | null;
  updated_at: number;
  error_message: string | null;
}

export interface RaiderSimLaunchContext {
  team_id: number;
  team_name: string;
  difficulty: SimDifficulty;
  char_name: string;
  realm_slug: string;
}

export interface PassiveSimTask {
  task_id: string;
  task_type: 'droptimizer' | 'single_target';
  site_team_id: number;
  difficulty: SimDifficulty;
  char_id: number;
  char_name: string;
  realm_slug: string;
  region: 'us';
  sim_raid: 'all';
  sim_difficulty: 'all';
  stale_seconds: number;
  last_sim_updated_at: number | null;
}

export interface PassiveSimTasksResponse {
  generated_at_utc: string;
  max_age_seconds: number;
  tasks: PassiveSimTask[];
}

export interface RaiderSingleTargetSnapshot {
  char_id: number;
  baseline_dps: number | null;
  top_dps: number | null;
  updated_at: number;
  finished_at_utc: string | null;
  site_team_id: number;
  difficulty: SimDifficulty;
}

export interface RaiderDroptimizerSnapshot {
  char_id: number;
  updated_at: number;
  finished_at_utc: string | null;
  site_team_id: number;
  difficulty: SimDifficulty;
}

export interface DesktopDroptimizerUpgradeEntry {
  blizzardCharId: number;
  character: string;
  realm: string;
  itemId: number;
  deltaDps: number;
  pctGain: number | null;
  difficulty: SimDifficulty;
  updatedAt: number;
}

interface SimRunsSchema {
  hasLastHeartbeatUtc: boolean;
  hasLastHeartbeatAt: boolean;
  hasSuccessful: boolean;
  rosterRevisionRequired: boolean;
  startedAtRequired: boolean;
}

interface SimTableNames {
  raiderSummaries: 'sim_raider_summaries';
  itemWinners: 'sim_item_winners';
  summaryRunFk: 'sim_run_id';
  winnerRunFk: 'sim_run_id';
}

export function normalizeDifficulty(value: string | null | undefined): SimDifficulty {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'mythic') return 'mythic';
  if (normalized === 'heroic' || normalized === 'flex') return 'heroic';
  return 'unknown';
}

type SourceDifficulty = 'mythic' | 'heroic' | 'normal' | 'lfr' | 'unknown';

function parseBonusIds(simc: string | null | undefined): number[] {
  const match = String(simc ?? '').match(/\bbonus_id=([0-9/]+)/i);
  if (!match) return [];
  return match[1]
    .split('/')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value));
}

function inferWinnerSourceDifficulty(winner: Pick<RaiderSimWinner, 'simc' | 'source' | 'ilvl'>): SourceDifficulty {
  const ids = parseBonusIds(winner.simc);
  if (ids.includes(4797)) return 'lfr';
  if (ids.includes(4798)) return 'normal';
  if (ids.includes(4800)) return 'mythic';
  if (ids.includes(4799)) return 'heroic';

  const sourceText = String(winner.source ?? '').toLowerCase();
  if (sourceText.includes('lfr') || sourceText.includes('raid finder')) return 'lfr';
  if (sourceText.includes('normal')) return 'normal';
  if (sourceText.includes('mythic')) return 'mythic';
  if (sourceText.includes('heroic')) return 'heroic';

  const ilvl = Number.parseInt(String(winner.ilvl ?? ''), 10);
  if (Number.isInteger(ilvl)) {
    if (ilvl >= 282) return 'mythic';
    if (ilvl >= 272) return 'heroic';
    if (ilvl >= 263) return 'normal';
    if (ilvl >= 250) return 'lfr';
  }

  return 'unknown';
}

function difficultySortOrder(value: string | null | undefined): number {
  const normalized = normalizeDifficulty(value);
  if (normalized === 'mythic') return 0;
  if (normalized === 'heroic') return 1;
  return 2;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const SIM_HISTORY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
// Accept known and future single-target tag variants so single-target snapshots
// stay visible even if runner_version naming drifts across builds.
const SINGLE_TARGET_RUNNER_SQL =
  "(sr.runner_version = 'wowsim-website-runner-v1-single-target' OR sr.runner_version LIKE '%single-target%' OR sr.runner_version LIKE '%single_target%')";

function toIsoNow(): string {
  return new Date().toISOString();
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

async function getTableNames(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set((rows.results ?? []).map((row) => row.name));
}

async function hasSimRunsTable(db: D1Database): Promise<boolean> {
  const tables = await getTableNames(db);
  return tables.has('sim_runs');
}

async function hasSimResultTables(db: D1Database): Promise<boolean> {
  const tables = await getTableNames(db);
  return tables.has('sim_raider_summaries') && tables.has('sim_item_winners');
}

async function getSimTableNames(_db: D1Database): Promise<SimTableNames> {
  return {
    raiderSummaries: 'sim_raider_summaries',
    itemWinners: 'sim_item_winners',
    summaryRunFk: 'sim_run_id',
    winnerRunFk: 'sim_run_id',
  };
}

async function getSimRunsSchema(db: D1Database): Promise<SimRunsSchema> {
  const info = await db.prepare('PRAGMA table_info(sim_runs)').all<{
    name: string;
    notnull: number;
  }>();
  const cols = new Map((info.results ?? []).map((row) => [row.name, row]));

  return {
    hasLastHeartbeatUtc: cols.has('last_heartbeat_utc'),
    hasLastHeartbeatAt: cols.has('last_heartbeat_at'),
    hasSuccessful: cols.has('successful'),
    rosterRevisionRequired: (cols.get('roster_revision')?.notnull ?? 0) === 1,
    startedAtRequired: (cols.get('started_at_utc')?.notnull ?? 0) === 1,
  };
}

export function validateSimResultsInput(payload: unknown): { value: SimResultsInput | null; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { value: null, errors: ['Payload must be a JSON object.'] };
  }

  const record = payload as Record<string, unknown>;
  const runId = typeof record.run_id === 'string' ? record.run_id.trim() : '';
  const siteTeamId = typeof record.site_team_id === 'number' ? record.site_team_id : Number.NaN;

  if (!runId) errors.push('run_id is required.');
  if (!Number.isInteger(siteTeamId) || siteTeamId <= 0) errors.push('site_team_id must be a positive integer.');
  if (!Array.isArray(record.raider_summaries)) errors.push('raider_summaries must be an array.');
  if (!Array.isArray(record.item_winners)) errors.push('item_winners must be an array.');
  if (record.item_scores !== undefined && !Array.isArray(record.item_scores)) {
    errors.push('item_scores must be an array when provided.');
  }

  if (errors.length > 0) return { value: null, errors };

  const raiderSummaries = (record.raider_summaries as unknown[]).map((entry) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    return {
      blizzard_char_id: Number(value.blizzard_char_id ?? NaN),
      baseline_dps: asFiniteNumber(value.baseline_dps),
      top_scenario: typeof value.top_scenario === 'string' ? value.top_scenario : null,
      top_dps: asFiniteNumber(value.top_dps),
      gain_dps: asFiniteNumber(value.gain_dps),
    } as SimRaiderSummaryInput;
  });

  const itemWinners = (record.item_winners as unknown[]).map((entry) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    return {
      slot: typeof value.slot === 'string' ? value.slot.trim() : '',
      item_id: Number.isFinite(Number(value.item_id)) ? Number(value.item_id) : null,
      item_label: typeof value.item_label === 'string' ? value.item_label : null,
      ilvl: Number.isFinite(Number(value.ilvl)) ? Number(value.ilvl) : null,
      source: typeof value.source === 'string' ? value.source : null,
      best_blizzard_char_id: Number.isFinite(Number(value.best_blizzard_char_id)) ? Number(value.best_blizzard_char_id) : null,
      delta_dps: asFiniteNumber(value.delta_dps),
      pct_gain: asFiniteNumber(value.pct_gain),
      simc: typeof value.simc === 'string' ? value.simc : null,
    } as SimItemWinnerInput;
  });

  const itemScores = (Array.isArray(record.item_scores) ? record.item_scores : []).map((entry) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    return {
      blizzard_char_id: Number(value.blizzard_char_id ?? NaN),
      slot: typeof value.slot === 'string' ? value.slot.trim() : '',
      item_id: Number.isFinite(Number(value.item_id)) ? Number(value.item_id) : null,
      item_label: typeof value.item_label === 'string' ? value.item_label : null,
      ilvl: Number.isFinite(Number(value.ilvl)) ? Number(value.ilvl) : null,
      source: typeof value.source === 'string' ? value.source : null,
      delta_dps: asFiniteNumber(value.delta_dps),
      pct_gain: asFiniteNumber(value.pct_gain),
      simc: typeof value.simc === 'string' ? value.simc : null,
    } as SimItemScoreInput;
  });

  for (const summary of raiderSummaries) {
    if (!Number.isInteger(summary.blizzard_char_id) || summary.blizzard_char_id <= 0) {
      errors.push('Each raider_summaries entry must include a positive blizzard_char_id.');
      break;
    }
  }

  for (const winner of itemWinners) {
    if (!winner.slot) {
      errors.push('Each item_winners entry must include a non-empty slot.');
      break;
    }
  }

  for (const score of itemScores) {
    if (!Number.isInteger(score.blizzard_char_id) || score.blizzard_char_id <= 0) {
      errors.push('Each item_scores entry must include a positive blizzard_char_id.');
      break;
    }
    if (!score.slot) {
      errors.push('Each item_scores entry must include a non-empty slot.');
      break;
    }
  }

  if (errors.length > 0) return { value: null, errors };

  return {
    value: {
      run_id: runId,
      roster_revision: typeof record.roster_revision === 'string' ? record.roster_revision : null,
      started_at_utc: typeof record.started_at_utc === 'string' ? record.started_at_utc : null,
      finished_at_utc: typeof record.finished_at_utc === 'string' ? record.finished_at_utc : null,
      site_team_id: siteTeamId,
      difficulty: typeof record.difficulty === 'string' ? record.difficulty : null,
      simc_version: typeof record.simc_version === 'string' ? record.simc_version : null,
      runner_version: typeof record.runner_version === 'string' ? record.runner_version : null,
      raider_summaries: raiderSummaries,
      item_winners: itemWinners,
      item_scores: itemScores,
    },
    errors: [],
  };
}

export async function getSimTargets(db: D1Database): Promise<SimTargetsResponse> {
  const rowsResult = await db
    .prepare(
      `SELECT
         rt.id AS team_id,
         rt.name AS team_name,
         rt.raid_mode,
         rtm.blizzard_char_id,
         rmc.name,
         rmc.realm_slug,
         rmc.level,
         rmc.rank
       FROM raid_teams rt
       JOIN raid_team_members rtm ON rtm.team_id = rt.id
       JOIN roster_members_cache rmc ON rmc.blizzard_char_id = rtm.blizzard_char_id
       WHERE rt.is_archived = 0
       ORDER BY rt.sort_order ASC, rt.name ASC, rmc.name ASC`
    )
    .all<RawTargetRow>();

  const rows = (rowsResult.results ?? []) as RawTargetRow[];
  const byTeam = new Map<number, SimTargetTeam>();

  for (const row of rows) {
    if (!byTeam.has(row.team_id)) {
      byTeam.set(row.team_id, {
        team_id: row.team_id,
        team_name: row.team_name,
        raid_mode: row.raid_mode,
        difficulty: row.raid_mode === 'mythic' ? 'mythic' : 'heroic',
        raiders: [],
      });
    }

    byTeam.get(row.team_id)!.raiders.push({
      blizzard_char_id: row.blizzard_char_id,
      name: row.name,
      realm_slug: row.realm_slug,
      region: 'us',
      level: Number(row.level ?? 0),
      guild_rank: Number(row.rank ?? 0),
      priority: null,
    });
  }

  const teams = [...byTeam.values()].map((team) => ({
    ...team,
    raiders: [...team.raiders].sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const canonical = JSON.stringify(
    teams.map((team) => ({
      team_id: team.team_id,
      difficulty: team.difficulty,
      raiders: team.raiders.map((raider) => raider.blizzard_char_id),
    }))
  );

  return {
    roster_revision: `fnv1a-${fnv1aHex(canonical)}`,
    generated_at_utc: toIsoNow(),
    teams,
  };
}

async function getSimRunId(db: D1Database, runId: string, siteTeamId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM sim_runs WHERE run_id = ? AND site_team_id = ? LIMIT 1')
    .bind(runId, siteTeamId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function getExistingSimResultCounts(
  db: D1Database,
  simRunId: number,
  simTables: SimTableNames
): Promise<{ raiderSummaries: number; itemWinners: number }> {
  const [summaryRow, winnerRow] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${simTables.raiderSummaries} WHERE ${simTables.summaryRunFk} = ?`)
      .bind(simRunId)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${simTables.itemWinners} WHERE ${simTables.winnerRunFk} = ?`)
      .bind(simRunId)
      .first<{ count: number }>(),
  ]);

  return {
    raiderSummaries: Number(summaryRow?.count ?? 0),
    itemWinners: Number(winnerRow?.count ?? 0),
  };
}

async function purgeStaleSimData(db: D1Database, simTables: SimTableNames): Promise<void> {
  const cutoff = nowSeconds() - SIM_HISTORY_RETENTION_SECONDS;

  await db
    .prepare(
      `DELETE FROM ${simTables.itemWinners}
       WHERE ${simTables.winnerRunFk} IN (
         SELECT id FROM sim_runs WHERE updated_at < ?
       )`
    )
    .bind(cutoff)
    .run();

  await db
    .prepare(
      `DELETE FROM ${simTables.raiderSummaries}
       WHERE ${simTables.summaryRunFk} IN (
         SELECT id FROM sim_runs WHERE updated_at < ?
       )`
    )
    .bind(cutoff)
    .run();

  await db
    .prepare('DELETE FROM sim_runs WHERE updated_at < ?')
    .bind(cutoff)
    .run();
}

function winnerMergeKey(winner: RaiderSimWinner): string {
  const slot = (winner.slot ?? '').trim().toLowerCase();
  const itemId = winner.item_id === null ? '' : String(winner.item_id);
  const source = (winner.source ?? '').trim().toLowerCase();
  const label = (winner.item_label ?? '').trim().toLowerCase();

  // Prefer stable item_id/source when available, with slot retained to keep
  // trinket/finger dual-slot entries distinct in the merged history.
  if (itemId) return `${slot}|id:${itemId}|src:${source}`;
  return `${slot}|label:${label}|src:${source}`;
}

function d1Changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: unknown } } | null | undefined)?.meta;
  return Number(meta?.changes ?? 0) || 0;
}

export async function insertSimResults(db: D1Database, input: SimResultsInput): Promise<InsertSimResultsResult> {
  console.log(
    `[insertSimResults] received: run_id=${input.run_id}, site_team_id=${input.site_team_id}, ` +
    `raider_summaries=${input.raider_summaries.length}, item_winners=${input.item_winners.length}`
  );
  const existingId = await getSimRunId(db, input.run_id, input.site_team_id);
  const now = nowSeconds();
  const status = 'finished';
  const difficulty = normalizeDifficulty(input.difficulty);
  const simRunsSchema = await getSimRunsSchema(db);
  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);
  if (existingId !== null) {
    const counts = await getExistingSimResultCounts(db, existingId, simTables);
    console.log(
      `[insertSimResults] run_id=${input.run_id}: found existing sim_runs row (id=${existingId}), ` +
      `child rows: raider_summaries=${counts.raiderSummaries}, item_winners=${counts.itemWinners}`
    );
    if (counts.raiderSummaries > 0 || counts.itemWinners > 0) {
      console.log(`[insertSimResults] run_id=${input.run_id}: returning early — duplicate detected`);
      return {
        success: true,
        duplicate: true,
        run_id: input.run_id,
        site_team_id: input.site_team_id,
      };
    }
    console.log(`[insertSimResults] run_id=${input.run_id}: existing row has no child rows, will reuse`);
  }

  const rosterRevision = input.roster_revision ?? (simRunsSchema.rosterRevisionRequired ? 'unknown' : null);
  const startedAtUtc = input.started_at_utc ?? (simRunsSchema.startedAtRequired ? toIsoNow() : null);

  let simRunId = existingId;
  if (simRunId === null) {
    await db
      .prepare(
        `INSERT INTO sim_runs (
          run_id,
          roster_revision,
          site_team_id,
          difficulty,
          status,
          started_at_utc,
          finished_at_utc,
          simc_version,
          runner_version,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.run_id,
        rosterRevision,
        input.site_team_id,
        difficulty,
        status,
        startedAtUtc,
        input.finished_at_utc ?? null,
        input.simc_version ?? null,
        input.runner_version ?? null,
        now,
        now
      )
      .run();

    simRunId = await getSimRunId(db, input.run_id, input.site_team_id);
    if (simRunId === null) {
      throw new Error('Failed to create sim run record.');
    }
  }

  const raiderStatements = input.raider_summaries.map((entry) => {
    return db
      .prepare(
        `INSERT INTO sim_raider_summaries (
          sim_run_id,
          blizzard_char_id,
          baseline_dps,
          top_scenario,
          top_dps,
          gain_dps,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        simRunId,
        entry.blizzard_char_id,
        entry.baseline_dps ?? null,
        entry.top_scenario ?? null,
        entry.top_dps ?? null,
        entry.gain_dps ?? null,
        now
      );
  });

  const winnerStatements = input.item_winners.map((entry) => {
    return db
      .prepare(
        `INSERT INTO sim_item_winners (
          sim_run_id,
          slot,
          item_id,
          item_label,
          ilvl,
          source,
          best_blizzard_char_id,
          delta_dps,
          pct_gain,
          simc,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        simRunId,
        entry.slot,
        entry.item_id ?? null,
        entry.item_label ?? null,
        entry.ilvl ?? null,
        entry.source ?? null,
        entry.best_blizzard_char_id ?? null,
        entry.delta_dps ?? null,
        entry.pct_gain ?? null,
        entry.simc ?? null,
        now
      );
  });

  const tables = await getTableNames(db);
  const itemScoreStatements = tables.has('sim_item_scores')
    ? (input.item_scores ?? []).map((entry) => {
        return db
          .prepare(
            `INSERT INTO sim_item_scores (
              sim_run_id,
              blizzard_char_id,
              slot,
              item_id,
              item_label,
              ilvl,
              source,
              delta_dps,
              pct_gain,
              simc,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            simRunId,
            entry.blizzard_char_id,
            entry.slot,
            entry.item_id ?? null,
            entry.item_label ?? null,
            entry.ilvl ?? null,
            entry.source ?? null,
            entry.delta_dps ?? null,
            entry.pct_gain ?? null,
            entry.simc ?? null,
            now
          );
      })
    : [];

  if (raiderStatements.length > 0) {
    console.log(
      `[insertSimResults] run_id=${input.run_id}: batch-inserting ${raiderStatements.length} raider_summaries rows`
    );
    await db.batch(raiderStatements);
  }
  if (winnerStatements.length > 0) {
    console.log(
      `[insertSimResults] run_id=${input.run_id}: batch-inserting ${winnerStatements.length} item_winners rows`
    );
    await db.batch(winnerStatements);
  }
  if (itemScoreStatements.length > 0) {
    console.log(
      `[insertSimResults] run_id=${input.run_id}: batch-inserting ${itemScoreStatements.length} item_scores rows`
    );
    await db.batch(itemScoreStatements);
  }

  const result = {
    success: true,
    duplicate: false,
    run_id: input.run_id,
    site_team_id: input.site_team_id,
    inserted: {
      raider_summaries: raiderStatements.length,
      item_winners: winnerStatements.length,
    },
  };
  console.log(
    `[insertSimResults] run_id=${input.run_id}: completed successfully, ` +
    `inserted: raider_summaries=${raiderStatements.length}, item_winners=${winnerStatements.length}`
  );
  return result;
}

export function validateLifecycleInput(payload: unknown): { value: LifecycleInput | null; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { value: null, errors: ['Payload must be a JSON object.'] };
  }

  const record = payload as Record<string, unknown>;
  const runId = typeof record.run_id === 'string' ? record.run_id.trim() : '';
  const siteTeamId = Number(record.site_team_id ?? NaN);

  if (!runId) errors.push('run_id is required.');
  if (!Number.isInteger(siteTeamId) || siteTeamId <= 0) errors.push('site_team_id must be a positive integer.');
  if (errors.length > 0) return { value: null, errors };

  const statusValue = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  let status: LifecycleInput['status'] | undefined;
  if (statusValue === 'running' || statusValue === 'finished' || statusValue === 'failed') {
    status = statusValue;
  }

  return {
    value: {
      run_id: runId,
      site_team_id: siteTeamId,
      roster_revision: typeof record.roster_revision === 'string' ? record.roster_revision : null,
      difficulty: typeof record.difficulty === 'string' ? record.difficulty : null,
      status,
      started_at_utc: typeof record.started_at_utc === 'string' ? record.started_at_utc : null,
      finished_at_utc: typeof record.finished_at_utc === 'string' ? record.finished_at_utc : null,
      error_message: typeof record.error_message === 'string' ? record.error_message : null,
      runner_version: typeof record.runner_version === 'string' ? record.runner_version : null,
    },
    errors: [],
  };
}

export async function upsertSimRunLifecycle(
  db: D1Database,
  input: LifecycleInput,
  fallbackStatus: 'running' | 'finished' | 'failed'
): Promise<{ success: boolean; run_id: string; site_team_id: number }> {
  const existingId = await getSimRunId(db, input.run_id, input.site_team_id);
  const simRunsSchema = await getSimRunsSchema(db);
  const now = nowSeconds();
  const difficulty = normalizeDifficulty(input.difficulty);
  const status = input.status ?? fallbackStatus;
  const rosterRevision = input.roster_revision ?? (simRunsSchema.rosterRevisionRequired ? 'unknown' : null);
  const startedAtUtc = input.started_at_utc ?? (simRunsSchema.startedAtRequired ? toIsoNow() : null);
  const heartbeatText = fallbackStatus === 'running' ? toIsoNow() : null;
  const heartbeatEpoch = fallbackStatus === 'running' ? now : null;
  const successful = status === 'failed' ? 0 : 1;

  if (existingId === null) {
    if (simRunsSchema.hasLastHeartbeatUtc) {
      await db
        .prepare(
          `INSERT INTO sim_runs (
            run_id,
            roster_revision,
            site_team_id,
            difficulty,
            status,
            started_at_utc,
            finished_at_utc,
            last_heartbeat_utc,
            error_message,
            runner_version,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.run_id,
          rosterRevision,
          input.site_team_id,
          difficulty,
          status,
          startedAtUtc,
          input.finished_at_utc ?? null,
          heartbeatText,
          input.error_message ?? null,
          input.runner_version ?? null,
          now,
          now
        )
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO sim_runs (
            run_id,
            site_team_id,
            roster_revision,
            difficulty,
            started_at_utc,
            finished_at_utc,
            status,
            successful,
            simc_version,
            runner_version,
            last_heartbeat_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.run_id,
          input.site_team_id,
          rosterRevision,
          difficulty,
          startedAtUtc,
          input.finished_at_utc ?? null,
          status,
          successful,
          null,
          input.runner_version ?? null,
          simRunsSchema.hasLastHeartbeatAt ? heartbeatEpoch : null,
          now,
          now
        )
        .run();
    }
  } else {
    if (simRunsSchema.hasLastHeartbeatUtc) {
      await db
        .prepare(
          `UPDATE sim_runs
           SET roster_revision = COALESCE(?, roster_revision),
               difficulty = COALESCE(?, difficulty),
               status = ?,
               started_at_utc = COALESCE(?, started_at_utc),
               finished_at_utc = COALESCE(?, finished_at_utc),
               last_heartbeat_utc = COALESCE(?, last_heartbeat_utc),
               error_message = COALESCE(?, error_message),
               runner_version = COALESCE(?, runner_version),
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          rosterRevision,
          difficulty === 'unknown' ? null : difficulty,
          status,
          startedAtUtc,
          input.finished_at_utc ?? null,
          heartbeatText,
          input.error_message ?? null,
          input.runner_version ?? null,
          now,
          existingId
        )
        .run();
    } else {
      await db
        .prepare(
          `UPDATE sim_runs
           SET roster_revision = COALESCE(?, roster_revision),
               difficulty = COALESCE(?, difficulty),
               status = ?,
               successful = ?,
               started_at_utc = COALESCE(?, started_at_utc),
               finished_at_utc = COALESCE(?, finished_at_utc),
               last_heartbeat_at = COALESCE(?, last_heartbeat_at),
               runner_version = COALESCE(?, runner_version),
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          rosterRevision,
          difficulty === 'unknown' ? null : difficulty,
          status,
          successful,
          startedAtUtc,
          input.finished_at_utc ?? null,
          simRunsSchema.hasLastHeartbeatAt ? heartbeatEpoch : null,
          input.runner_version ?? null,
          now,
          existingId
        )
        .run();
    }
  }

  return {
    success: true,
    run_id: input.run_id,
    site_team_id: input.site_team_id,
  };
}

export async function getLatestSimForRaider(
  db: D1Database,
  charId: number
): Promise<RaiderSimRecommendations | null> {
  if (!(await hasSimRunsTable(db))) return null;
  if (!(await hasSimResultTables(db))) return null;

  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);

  const cutoff = nowSeconds() - SIM_HISTORY_RETENTION_SECONDS;

  const runRow = await db
    .prepare(
      `SELECT
         sr.id,
         sr.run_id,
         sr.site_team_id,
         sr.difficulty,
         sr.finished_at_utc,
         sr.updated_at
       FROM sim_runs sr
       JOIN ${simTables.itemWinners} siw ON siw.${simTables.winnerRunFk} = sr.id
       WHERE sr.status = 'finished'
         AND siw.best_blizzard_char_id = ?
         AND sr.updated_at >= ?
       ORDER BY COALESCE(sr.finished_at_utc, '') DESC, sr.updated_at DESC
       LIMIT 1`
    )
    .bind(charId, cutoff)
    .first<{
      id: number;
      run_id: string;
      site_team_id: number;
      difficulty: string;
      finished_at_utc: string | null;
      updated_at: number;
    }>();

  if (!runRow) return null;

  const winnersResult = await db
    .prepare(
      `SELECT
         slot,
         item_id,
         item_label,
         ilvl,
         source,
         delta_dps,
         pct_gain,
         simc,
         sr.updated_at AS run_updated_at
       FROM ${simTables.itemWinners}
       JOIN sim_runs sr ON sr.id = ${simTables.itemWinners}.${simTables.winnerRunFk}
       WHERE best_blizzard_char_id = ?
         AND sr.status = 'finished'
         AND sr.updated_at >= ?
       ORDER BY sr.updated_at DESC, COALESCE(delta_dps, 0) DESC, slot ASC`
    )
    .bind(charId, cutoff)
    .all<RaiderSimWinner & { run_updated_at: number | null }>();

  const merged = new Map<string, RaiderSimWinner>();
  for (const winner of (winnersResult.results ?? []) as Array<RaiderSimWinner & { run_updated_at: number | null }>) {
    const key = winnerMergeKey(winner);
    if (merged.has(key)) continue;
    merged.set(key, {
      slot: winner.slot,
      item_id: winner.item_id,
      item_label: winner.item_label,
      ilvl: winner.ilvl,
      source: winner.source,
      delta_dps: winner.delta_dps,
      pct_gain: winner.pct_gain,
      simc: winner.simc,
    });
  }

  const winners = [...merged.values()].sort((a, b) => {
    const da = Number(a.delta_dps ?? Number.NEGATIVE_INFINITY);
    const dbv = Number(b.delta_dps ?? Number.NEGATIVE_INFINITY);
    if (dbv !== da) return dbv - da;
    return String(a.slot ?? '').localeCompare(String(b.slot ?? ''));
  });

  return {
    run_id: runRow.run_id,
    site_team_id: runRow.site_team_id,
    difficulty: runRow.difficulty,
    finished_at_utc: runRow.finished_at_utc,
    updated_at: runRow.updated_at,
    winners,
  };
}

export async function getLatestSimsForRaiderByDifficulty(
  db: D1Database,
  charId: number,
  options?: { maxAgeSeconds?: number }
): Promise<RaiderSimRecommendations[]> {
  if (!(await hasSimRunsTable(db))) return [];
  if (!(await hasSimResultTables(db))) return [];

  const maxAgeSeconds = Math.max(60 * 60, Math.min(30 * 24 * 60 * 60, options?.maxAgeSeconds ?? 14 * 24 * 60 * 60));
  const cutoff = nowSeconds() - maxAgeSeconds;
  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);

  const runRowsResult = await db
    .prepare(
      `SELECT
         DISTINCT sr.id,
         sr.run_id,
         sr.site_team_id,
         sr.difficulty,
         sr.finished_at_utc,
         sr.updated_at
       FROM sim_runs sr
       JOIN ${simTables.itemWinners} siw ON siw.${simTables.winnerRunFk} = sr.id
       WHERE sr.status = 'finished'
         AND siw.best_blizzard_char_id = ?
         AND sr.updated_at >= ?
       ORDER BY COALESCE(sr.finished_at_utc, '') DESC, sr.updated_at DESC, sr.id DESC`
    )
    .bind(charId, cutoff)
    .all<{
      id: number;
      run_id: string;
      site_team_id: number;
      difficulty: string;
      finished_at_utc: string | null;
      updated_at: number;
    }>();

  const runRows = (runRowsResult.results ?? []) as Array<{
    id: number;
    run_id: string;
    site_team_id: number;
    difficulty: string;
    finished_at_utc: string | null;
    updated_at: number;
  }>;
  if (runRows.length === 0) return [];

  const runIds = runRows.map((row) => row.id);
  const placeholders = runIds.map(() => '?').join(', ');
  const winnersResult = await db
    .prepare(
      `SELECT
         ${simTables.itemWinners}.${simTables.winnerRunFk} AS sim_run_id,
         slot,
         item_id,
         item_label,
         ilvl,
         source,
         delta_dps,
         pct_gain,
         simc
       FROM ${simTables.itemWinners}
       WHERE ${simTables.itemWinners}.${simTables.winnerRunFk} IN (${placeholders})
       ORDER BY COALESCE(delta_dps, 0) DESC, slot ASC`
    )
    .bind(...runIds)
    .all<(RaiderSimWinner & { sim_run_id: number })>();

  const winnersByRunId = new Map<number, RaiderSimWinner[]>();
  for (const winner of (winnersResult.results ?? []) as Array<RaiderSimWinner & { sim_run_id: number }>) {
    const existing = winnersByRunId.get(winner.sim_run_id) ?? [];
    existing.push({
      slot: winner.slot,
      item_id: winner.item_id,
      item_label: winner.item_label,
      ilvl: winner.ilvl,
      source: winner.source,
      delta_dps: winner.delta_dps,
      pct_gain: winner.pct_gain,
      simc: winner.simc,
    });
    winnersByRunId.set(winner.sim_run_id, existing);
  }

  const recommendationsByDifficulty = new Map<'heroic' | 'mythic', RaiderSimRecommendations>();
  for (const runRow of runRows) {
    const groupedWinners = new Map<'heroic' | 'mythic', RaiderSimWinner[]>();
    for (const winner of winnersByRunId.get(runRow.id) ?? []) {
      const sourceDifficulty = inferWinnerSourceDifficulty(winner);
      if (sourceDifficulty !== 'heroic' && sourceDifficulty !== 'mythic') continue;
      const existing = groupedWinners.get(sourceDifficulty) ?? [];
      existing.push(winner);
      groupedWinners.set(sourceDifficulty, existing);
    }

    for (const [difficulty, difficultyWinners] of groupedWinners.entries()) {
      if (recommendationsByDifficulty.has(difficulty)) continue;

      const merged = new Map<string, RaiderSimWinner>();
      for (const winner of difficultyWinners) {
        const key = winnerMergeKey(winner);
        if (merged.has(key)) continue;
        merged.set(key, winner);
      }

      const winners = [...merged.values()].sort((a, b) => {
        const da = Number(a.delta_dps ?? Number.NEGATIVE_INFINITY);
        const dbv = Number(b.delta_dps ?? Number.NEGATIVE_INFINITY);
        if (dbv !== da) return dbv - da;
        return String(a.slot ?? '').localeCompare(String(b.slot ?? ''));
      });

      recommendationsByDifficulty.set(difficulty, {
        run_id: runRow.run_id,
        site_team_id: runRow.site_team_id,
        difficulty,
        finished_at_utc: runRow.finished_at_utc,
        updated_at: runRow.updated_at,
        winners,
      });
    }

    if (recommendationsByDifficulty.has('heroic') && recommendationsByDifficulty.has('mythic')) {
      break;
    }
  }

  const recommendations = [...recommendationsByDifficulty.values()];

  recommendations.sort((a, b) => {
    const difficultyDelta = difficultySortOrder(a.difficulty) - difficultySortOrder(b.difficulty);
    if (difficultyDelta !== 0) return difficultyDelta;
    return b.updated_at - a.updated_at;
  });

  return recommendations;
}

export async function getDesktopDroptimizerUpgrades(
  db: D1Database,
  options?: { maxAgeSeconds?: number }
): Promise<DesktopDroptimizerUpgradeEntry[]> {
  if (!(await hasSimRunsTable(db))) return [];

  const tables = await getTableNames(db);
  if (!tables.has('sim_item_scores')) return [];

  const maxAgeSeconds = Math.max(60 * 60, Math.min(30 * 24 * 60 * 60, options?.maxAgeSeconds ?? 14 * 24 * 60 * 60));
  const cutoff = nowSeconds() - maxAgeSeconds;

  const runRowsResult = await db
    .prepare(
      `SELECT sr.id, sr.difficulty, sr.updated_at
       FROM sim_runs sr
       WHERE sr.status = 'finished'
         AND sr.updated_at >= ?
         AND (sr.runner_version IS NULL OR (${SINGLE_TARGET_RUNNER_SQL}) = 0)
       ORDER BY COALESCE(sr.finished_at_utc, '') DESC, sr.updated_at DESC, sr.id DESC`
    )
    .bind(cutoff)
    .all<{ id: number; difficulty: string; updated_at: number }>();

  const latestRunByDifficulty = new Map<SimDifficulty, { id: number; updated_at: number }>();
  for (const row of runRowsResult.results ?? []) {
    const normalized = normalizeDifficulty(row.difficulty);
    if (normalized === 'unknown') continue;
    if (!latestRunByDifficulty.has(normalized)) {
      latestRunByDifficulty.set(normalized, { id: row.id, updated_at: row.updated_at });
    }
    if (latestRunByDifficulty.has('heroic') && latestRunByDifficulty.has('mythic')) {
      break;
    }
  }

  const runIds = [...latestRunByDifficulty.values()].map((row) => row.id);
  if (runIds.length === 0) return [];

  const placeholders = runIds.map(() => '?').join(', ');

  type ScoreRow = {
    blizzard_char_id: number;
    name: string;
    realm: string;
    item_id: number;
    delta_dps: number;
    pct_gain: number | null;
    difficulty: string;
    updated_at: number;
  };

  // Primary source: per-character per-item scores (populated by LodgeSim v1.4.0+).
  const itemScoreRowsResult = await db
    .prepare(
      `SELECT
         sis.blizzard_char_id,
         c.name,
         c.realm,
         sis.item_id,
         sis.delta_dps,
         sis.pct_gain,
         sr.difficulty,
         sr.updated_at
       FROM sim_item_scores sis
       JOIN sim_runs sr ON sr.id = sis.sim_run_id
       JOIN roster_members_cache c ON c.blizzard_char_id = sis.blizzard_char_id
       WHERE sis.sim_run_id IN (${placeholders})
         AND sis.item_id IS NOT NULL
       ORDER BY sr.updated_at DESC, sis.delta_dps DESC`
    )
    .bind(...runIds)
    .all<ScoreRow>();

  // Fallback: when sim_item_scores is empty for the selected runs (older LodgeSim
  // versions did not submit item_scores), use sim_item_winners which stores the
  // per-item best winner. This gives one entry per item rather than per character,
  // but avoids a completely empty droptimizer sync until a fresh run populates scores.
  const useWinnerFallback = (itemScoreRowsResult.results ?? []).length === 0;

  let rawRows: ScoreRow[];
  if (useWinnerFallback) {
    const winnerRowsResult = await db
      .prepare(
        `SELECT
           siw.best_blizzard_char_id AS blizzard_char_id,
           c.name,
           c.realm,
           siw.item_id,
           siw.delta_dps,
           siw.pct_gain,
           sr.difficulty,
           sr.updated_at
         FROM sim_item_winners siw
         JOIN sim_runs sr ON sr.id = siw.sim_run_id
         JOIN roster_members_cache c ON c.blizzard_char_id = siw.best_blizzard_char_id
         WHERE siw.sim_run_id IN (${placeholders})
           AND siw.item_id IS NOT NULL
           AND siw.best_blizzard_char_id IS NOT NULL
         ORDER BY sr.updated_at DESC, siw.delta_dps DESC`
      )
      .bind(...runIds)
      .all<ScoreRow>();
    rawRows = winnerRowsResult.results ?? [];
  } else {
    rawRows = itemScoreRowsResult.results ?? [];
  }

  const deduped = new Map<string, DesktopDroptimizerUpgradeEntry>();
  for (const row of rawRows) {
    const difficulty = normalizeDifficulty(row.difficulty);
    if (difficulty === 'unknown') continue;
    const itemId = Number(row.item_id ?? NaN);
    const delta = Number(row.delta_dps ?? NaN);
    if (!Number.isFinite(itemId) || itemId <= 0 || !Number.isFinite(delta)) continue;

    const key = `${difficulty}|${row.blizzard_char_id}|${itemId}`;
    if (deduped.has(key)) continue;

    deduped.set(key, {
      blizzardCharId: Number(row.blizzard_char_id),
      character: String(row.name ?? ''),
      realm: String(row.realm ?? ''),
      itemId: itemId,
      deltaDps: delta,
      pctGain: row.pct_gain == null ? null : Number(row.pct_gain),
      difficulty,
      updatedAt: Number(row.updated_at ?? 0),
    });
  }

  const entries = [...deduped.values()];
  entries.sort((a, b) => {
    if (a.itemId !== b.itemId) return a.itemId - b.itemId;
    if (a.character !== b.character) return a.character.localeCompare(b.character);
    return b.deltaDps - a.deltaDps;
  });

  return entries;
}

export async function purgeSimHistoryForRaider(
  db: D1Database,
  charId: number
): Promise<PurgeSimHistoryResult> {
  if (!(await hasSimRunsTable(db))) {
    return {
      deleted_runs: 0,
      deleted_raider_summaries: 0,
      deleted_item_winners: 0,
    };
  }

  if (!(await hasSimResultTables(db))) {
    return {
      deleted_runs: 0,
      deleted_raider_summaries: 0,
      deleted_item_winners: 0,
    };
  }

  const simTables = await getSimTableNames(db);
  const tables = await getTableNames(db);

  const winnerDeleteResult = await db
    .prepare(
      `DELETE FROM ${simTables.itemWinners}
       WHERE best_blizzard_char_id = ?`
    )
    .bind(charId)
    .run();

  const summaryDeleteResult = await db
    .prepare(
      `DELETE FROM ${simTables.raiderSummaries}
       WHERE blizzard_char_id = ?`
    )
    .bind(charId)
    .run();

  const runReferenceChecks: string[] = [];
  if (tables.has('sim_item_winners')) {
    runReferenceChecks.push(
      'NOT EXISTS (SELECT 1 FROM sim_item_winners siw WHERE siw.sim_run_id = sim_runs.id)'
    );
  }
  if (tables.has('sim_raider_summaries')) {
    runReferenceChecks.push(
      'NOT EXISTS (SELECT 1 FROM sim_raider_summaries srs WHERE srs.sim_run_id = sim_runs.id)'
    );
  }

  let runDeleteChanges = 0;
  if (runReferenceChecks.length > 0) {
    const runDeleteResult = await db
      .prepare(
        `DELETE FROM sim_runs
         WHERE ${runReferenceChecks.join('\n           AND ')}`
      )
      .run();
    runDeleteChanges = d1Changes(runDeleteResult);
  }

  return {
    deleted_runs: runDeleteChanges,
    deleted_raider_summaries: d1Changes(summaryDeleteResult),
    deleted_item_winners: d1Changes(winnerDeleteResult),
  };
}

export async function purgeAllSimHistory(db: D1Database): Promise<PurgeAllSimHistoryResult> {
  const tables = await getTableNames(db);

  let deletedItemWinners = 0;
  let deletedRaiderSummaries = 0;
  let deletedRuns = 0;

  if (tables.has('sim_item_winners')) {
    const result = await db.prepare('DELETE FROM sim_item_winners').run();
    deletedItemWinners = d1Changes(result);
  }

  if (tables.has('sim_raider_summaries')) {
    const result = await db.prepare('DELETE FROM sim_raider_summaries').run();
    deletedRaiderSummaries = d1Changes(result);
  }

  if (tables.has('sim_runs')) {
    const result = await db.prepare('DELETE FROM sim_runs').run();
    deletedRuns = d1Changes(result);
  }

  return {
    deleted_runs: deletedRuns,
    deleted_raider_summaries: deletedRaiderSummaries,
    deleted_item_winners: deletedItemWinners,
  };
}

export async function getSimLaunchContextForRaider(
  db: D1Database,
  charId: number
): Promise<RaiderSimLaunchContext | null> {
  const row = await db
    .prepare(
      `SELECT
         rt.id AS team_id,
         rt.name AS team_name,
         rt.raid_mode AS raid_mode,
         rmc.name AS char_name,
         rmc.realm_slug
       FROM raid_team_members rtm
       JOIN raid_teams rt ON rt.id = rtm.team_id
       JOIN roster_members_cache rmc ON rmc.blizzard_char_id = rtm.blizzard_char_id
       WHERE rtm.blizzard_char_id = ?
         AND rt.is_archived = 0
       ORDER BY rt.sort_order ASC, rt.name ASC
       LIMIT 1`
    )
    .bind(charId)
    .first<{
      team_id: number;
      team_name: string;
      raid_mode: string;
      char_name: string;
      realm_slug: string;
    }>();

  if (!row) return null;

  return {
    team_id: Number(row.team_id),
    team_name: row.team_name,
    difficulty: normalizeDifficulty(row.raid_mode),
    char_name: row.char_name,
    realm_slug: row.realm_slug,
  };
}

export async function getLatestSimByTeam(
  db: D1Database,
  siteTeamId: number,
  difficulty?: string
): Promise<{
  latest_run: SimLatestRunIndicator | null;
  run_id: string;
  site_team_id: number;
  difficulty: string;
  finished_at_utc: string | null;
  updated_at: number;
  winners: Array<RaiderSimWinner & { best_blizzard_char_id: number | null }>;
} | null> {
  if (!(await hasSimRunsTable(db))) return null;
  if (!(await hasSimResultTables(db))) return null;

  const normalizedDifficulty = normalizeDifficulty(difficulty);
  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);
  const latestRun = await db
    .prepare(
      `SELECT id, run_id, site_team_id, difficulty, status, finished_at_utc, updated_at, error_message
       FROM sim_runs
       WHERE site_team_id = ?
         AND (? = 'unknown' OR difficulty = ?)
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .bind(siteTeamId, normalizedDifficulty, normalizedDifficulty)
    .first<{
      id: number;
      run_id: string;
      site_team_id: number;
      difficulty: string;
      status: string;
      finished_at_utc: string | null;
      updated_at: number;
      error_message: string | null;
    }>();

  const latestRunIndicator: SimLatestRunIndicator | null = latestRun
    ? {
        run_id: latestRun.run_id,
        site_team_id: latestRun.site_team_id,
        difficulty: latestRun.difficulty,
        status: latestRun.status,
        finished_at_utc: latestRun.finished_at_utc,
        updated_at: latestRun.updated_at,
        error_message: latestRun.error_message,
      }
    : null;

  const runRow = await db
    .prepare(
      `SELECT id, run_id, site_team_id, difficulty, finished_at_utc, updated_at
       FROM sim_runs
       WHERE site_team_id = ?
         AND status = 'finished'
         AND (? = 'unknown' OR difficulty = ?)
       ORDER BY COALESCE(finished_at_utc, '') DESC, updated_at DESC
       LIMIT 1`
    )
    .bind(siteTeamId, normalizedDifficulty, normalizedDifficulty)
    .first<{
      id: number;
      run_id: string;
      site_team_id: number;
      difficulty: string;
      finished_at_utc: string | null;
      updated_at: number;
    }>();

  if (!runRow) {
    if (!latestRunIndicator) return null;
    return {
      latest_run: latestRunIndicator,
      run_id: latestRunIndicator.run_id,
      site_team_id: latestRunIndicator.site_team_id,
      difficulty: latestRunIndicator.difficulty,
      finished_at_utc: latestRunIndicator.finished_at_utc,
      updated_at: latestRunIndicator.updated_at,
      winners: [],
    };
  }

  const winnersResult = await db
    .prepare(
      `SELECT
         slot,
         item_id,
         item_label,
         ilvl,
         source,
         best_blizzard_char_id,
         delta_dps,
         pct_gain,
         simc
       FROM ${simTables.itemWinners}
       WHERE ${simTables.winnerRunFk} = ?
       ORDER BY COALESCE(delta_dps, 0) DESC, slot ASC`
    )
    .bind(runRow.id)
    .all<RaiderSimWinner & { best_blizzard_char_id: number | null }>();

  return {
    latest_run: latestRunIndicator,
    run_id: runRow.run_id,
    site_team_id: runRow.site_team_id,
    difficulty: runRow.difficulty,
    finished_at_utc: runRow.finished_at_utc,
    updated_at: runRow.updated_at,
    winners: (winnersResult.results ?? []) as Array<RaiderSimWinner & { best_blizzard_char_id: number | null }> ,
  };
}

export async function getPassiveSimTasks(
  db: D1Database,
  options?: { maxTasks?: number; maxAgeSeconds?: number }
): Promise<PassiveSimTasksResponse> {
  const maxTasks = Math.max(1, Math.min(100, options?.maxTasks ?? 20));
  const maxAgeSeconds = Math.max(60 * 60, Math.min(7 * 24 * 60 * 60, options?.maxAgeSeconds ?? 24 * 60 * 60));

  if (!(await hasSimRunsTable(db))) {
    return {
      generated_at_utc: toIsoNow(),
      max_age_seconds: maxAgeSeconds,
      tasks: [],
    };
  }

  if (!(await hasSimResultTables(db))) {
    return {
      generated_at_utc: toIsoNow(),
      max_age_seconds: maxAgeSeconds,
      tasks: [],
    };
  }

  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);

  const targets = await getSimTargets(db);
  const now = nowSeconds();

  const latestSingleRows = await db
    .prepare(
      `SELECT
         sr.site_team_id,
         sr.difficulty,
         srs.blizzard_char_id AS char_id,
         MAX(sr.updated_at) AS last_updated_at
       FROM sim_runs sr
       JOIN ${simTables.raiderSummaries} srs ON srs.${simTables.summaryRunFk} = sr.id
       WHERE sr.status = 'finished'
         AND ${SINGLE_TARGET_RUNNER_SQL}
       GROUP BY sr.site_team_id, sr.difficulty, srs.blizzard_char_id`
    )
    .all<{
      site_team_id: number;
      difficulty: string;
      char_id: number;
      last_updated_at: number | null;
    }>();

  const latestDroptimizerRows = await db
    .prepare(
      `SELECT
         sr.site_team_id,
         sr.difficulty,
         siw.best_blizzard_char_id AS char_id,
         MAX(sr.updated_at) AS last_updated_at
       FROM sim_runs sr
       JOIN ${simTables.itemWinners} siw ON siw.${simTables.winnerRunFk} = sr.id
       WHERE sr.status = 'finished'
         AND siw.best_blizzard_char_id IS NOT NULL
         AND NOT ${SINGLE_TARGET_RUNNER_SQL}
       GROUP BY sr.site_team_id, sr.difficulty, siw.best_blizzard_char_id`
    )
    .all<{
      site_team_id: number;
      difficulty: string;
      char_id: number;
      last_updated_at: number | null;
    }>();

  const latestSingleByKey = new Map<string, number | null>();
  for (const row of (latestSingleRows.results ?? []) as Array<{
    site_team_id: number;
    difficulty: string;
    char_id: number;
    last_updated_at: number | null;
  }>) {
    const diff = normalizeDifficulty(row.difficulty);
    const key = `${row.site_team_id}:${diff}:${row.char_id}`;
    latestSingleByKey.set(key, row.last_updated_at ?? null);
  }

  const latestDroptimizerByKey = new Map<string, number | null>();
  for (const row of (latestDroptimizerRows.results ?? []) as Array<{
    site_team_id: number;
    difficulty: string;
    char_id: number;
    last_updated_at: number | null;
  }>) {
    const diff = normalizeDifficulty(row.difficulty);
    const key = `${row.site_team_id}:${diff}:${row.char_id}`;
    latestDroptimizerByKey.set(key, row.last_updated_at ?? null);
  }

  const tasks: PassiveSimTask[] = [];
  for (const team of targets.teams) {
    const difficulty = normalizeDifficulty(team.difficulty);
    if (difficulty === 'unknown') continue;

    for (const raider of team.raiders) {
      const key = `${team.team_id}:${difficulty}:${raider.blizzard_char_id}`;
      const singleTargetLastUpdated = latestSingleByKey.get(key) ?? null;
      const singleTargetStaleSeconds = singleTargetLastUpdated ? Math.max(0, now - singleTargetLastUpdated) : maxAgeSeconds + 1;
      const droptimizerLastUpdated = latestDroptimizerByKey.get(key) ?? null;
      const droptimizerStaleSeconds = droptimizerLastUpdated ? Math.max(0, now - droptimizerLastUpdated) : maxAgeSeconds + 1;

      const commonTask = {
        site_team_id: team.team_id,
        difficulty,
        char_id: raider.blizzard_char_id,
        char_name: raider.name,
        realm_slug: raider.realm_slug,
        region: 'us' as const,
        sim_raid: 'all' as const,
        sim_difficulty: 'all' as const,
      };

      if (singleTargetStaleSeconds >= maxAgeSeconds) {
        tasks.push({
          task_id: `${team.team_id}:${difficulty}:${raider.blizzard_char_id}:single_target`,
          task_type: 'single_target',
          stale_seconds: singleTargetStaleSeconds,
          last_sim_updated_at: singleTargetLastUpdated,
          ...commonTask,
        });
      }

      if (droptimizerStaleSeconds >= maxAgeSeconds) {
        tasks.push({
          task_id: `${team.team_id}:${difficulty}:${raider.blizzard_char_id}:droptimizer`,
          task_type: 'droptimizer',
          stale_seconds: droptimizerStaleSeconds,
          last_sim_updated_at: droptimizerLastUpdated,
          ...commonTask,
        });
      }
    }
  }

  tasks.sort((a, b) => {
    if (a.task_type !== b.task_type) {
      return a.task_type === 'single_target' ? -1 : 1;
    }
    const aMissing = a.last_sim_updated_at == null;
    const bMissing = b.last_sim_updated_at == null;
    if (aMissing !== bMissing) return aMissing ? -1 : 1;
    if (b.stale_seconds !== a.stale_seconds) return b.stale_seconds - a.stale_seconds;
    if (a.site_team_id !== b.site_team_id) return a.site_team_id - b.site_team_id;
    return a.char_name.localeCompare(b.char_name);
  });

  return {
    generated_at_utc: toIsoNow(),
    max_age_seconds: maxAgeSeconds,
    tasks: tasks.slice(0, maxTasks),
  };
}

export async function getLatestDroptimizerForRaiders(
  db: D1Database,
  charIds: number[],
  options?: { maxAgeSeconds?: number }
): Promise<Map<number, RaiderDroptimizerSnapshot>> {
  const snapshots = new Map<number, RaiderDroptimizerSnapshot>();
  const normalizedCharIds = [...new Set(charIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedCharIds.length === 0) return snapshots;

  if (!(await hasSimRunsTable(db))) return snapshots;
  if (!(await hasSimResultTables(db))) return snapshots;

  const maxAgeSeconds = Math.max(60 * 60, Math.min(30 * 24 * 60 * 60, options?.maxAgeSeconds ?? 14 * 24 * 60 * 60));
  const cutoff = nowSeconds() - maxAgeSeconds;
  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);

  const placeholders = normalizedCharIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT
         latest.char_id,
         latest.updated_at,
         latest.finished_at_utc,
         latest.site_team_id,
         latest.difficulty
       FROM (
         SELECT
           siw.best_blizzard_char_id AS char_id,
           sr.updated_at,
           sr.finished_at_utc,
           sr.site_team_id,
           sr.difficulty,
           ROW_NUMBER() OVER (
             PARTITION BY siw.best_blizzard_char_id
             ORDER BY sr.updated_at DESC, sr.id DESC
           ) AS rn
         FROM sim_runs sr
         JOIN ${simTables.itemWinners} siw ON siw.${simTables.winnerRunFk} = sr.id
         WHERE sr.status = 'finished'
           AND sr.updated_at >= ?
           AND siw.best_blizzard_char_id IN (${placeholders})
       ) latest
       WHERE latest.rn = 1`
    )
    .bind(cutoff, ...normalizedCharIds)
    .all<{
      char_id: number;
      updated_at: number;
      finished_at_utc: string | null;
      site_team_id: number;
      difficulty: string;
    }>();

  for (const row of (result.results ?? []) as Array<{
    char_id: number;
    updated_at: number;
    finished_at_utc: string | null;
    site_team_id: number;
    difficulty: string;
  }>) {
    snapshots.set(row.char_id, {
      char_id: row.char_id,
      updated_at: row.updated_at,
      finished_at_utc: row.finished_at_utc,
      site_team_id: row.site_team_id,
      difficulty: normalizeDifficulty(row.difficulty),
    });
  }

  return snapshots;
}

export async function getLatestSingleTargetForRaiders(
  db: D1Database,
  charIds: number[],
  options?: { maxAgeSeconds?: number }
): Promise<Map<number, RaiderSingleTargetSnapshot>> {
  const snapshots = new Map<number, RaiderSingleTargetSnapshot>();
  const normalizedCharIds = [...new Set(charIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedCharIds.length === 0) return snapshots;

  if (!(await hasSimRunsTable(db))) return snapshots;
  if (!(await hasSimResultTables(db))) return snapshots;

  const maxAgeSeconds = Math.max(60 * 60, Math.min(30 * 24 * 60 * 60, options?.maxAgeSeconds ?? 7 * 24 * 60 * 60));
  const cutoff = nowSeconds() - maxAgeSeconds;
  const simTables = await getSimTableNames(db);
  await purgeStaleSimData(db, simTables);

  const placeholders = normalizedCharIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT
         latest.char_id,
         latest.baseline_dps,
         latest.top_dps,
         latest.updated_at,
         latest.finished_at_utc,
         latest.site_team_id,
         latest.difficulty
       FROM (
         SELECT
           srs.blizzard_char_id AS char_id,
           srs.baseline_dps,
           srs.top_dps,
           sr.updated_at,
           sr.finished_at_utc,
           sr.site_team_id,
           sr.difficulty,
           ROW_NUMBER() OVER (
             PARTITION BY srs.blizzard_char_id
             ORDER BY sr.updated_at DESC, sr.id DESC
           ) AS rn
         FROM sim_runs sr
         JOIN ${simTables.raiderSummaries} srs ON srs.${simTables.summaryRunFk} = sr.id
         WHERE sr.status = 'finished'
           AND sr.updated_at >= ?
           AND ${SINGLE_TARGET_RUNNER_SQL}
           AND srs.blizzard_char_id IN (${placeholders})
       ) latest
       WHERE latest.rn = 1`
    )
    .bind(cutoff, ...normalizedCharIds)
    .all<{
      char_id: number;
      baseline_dps: number | null;
      top_dps: number | null;
      updated_at: number;
      finished_at_utc: string | null;
      site_team_id: number;
      difficulty: string;
    }>();

  for (const row of (result.results ?? []) as Array<{
    char_id: number;
    baseline_dps: number | null;
    top_dps: number | null;
    updated_at: number;
    finished_at_utc: string | null;
    site_team_id: number;
    difficulty: string;
  }>) {
    snapshots.set(row.char_id, {
      char_id: row.char_id,
      baseline_dps: row.baseline_dps,
      top_dps: row.top_dps,
      updated_at: row.updated_at,
      finished_at_utc: row.finished_at_utc,
      site_team_id: row.site_team_id,
      difficulty: normalizeDifficulty(row.difficulty),
    });
  }

  return snapshots;
}
