#!/usr/bin/env node

import { execSync } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);
const DATABASE_NAME = 'hidden-lodge-db';
const TEMP_SQL_PATH = join(PROJECT_ROOT, '.tmp-reconcile-local-d1.sql');

function runCommand(commandLine) {
  return execSync(commandLine, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseJsonOutput(output) {
  const jsonMatch = output.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON payload found in output:\n${output}`);
  }
  return JSON.parse(jsonMatch[0]);
}

function runLocalSqlCommand(sql) {
  const escapedSql = sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  return runCommand(
    `npx wrangler d1 execute ${DATABASE_NAME} --local --json --command "${escapedSql}"`
  );
}

function runLocalSqlFile(sql) {
  writeFileSync(TEMP_SQL_PATH, `${sql.trim()}\n`, 'utf8');
  try {
    return runCommand(`npx wrangler d1 execute ${DATABASE_NAME} --local --file "${TEMP_SQL_PATH}"`);
  } finally {
    rmSync(TEMP_SQL_PATH, { force: true });
  }
}

function getSimRunsColumns() {
  const output = runLocalSqlCommand('PRAGMA table_info(sim_runs);');
  const parsed = parseJsonOutput(output);
  const rows = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
  return new Set(rows.map((row) => row.name));
}

function main() {
  try {
    const columns = getSimRunsColumns();
    const hasLegacyHeartbeat = columns.has('last_heartbeat_at');
    const hasCanonicalHeartbeat = columns.has('last_heartbeat_utc');
    const hasErrorMessage = columns.has('error_message');
    const needsSimReconcile = hasLegacyHeartbeat || !hasCanonicalHeartbeat || !hasErrorMessage;

    console.log('Reconciling local schema drift against canonical repo migrations...');

    const statements = [
      'BEGIN TRANSACTION;',
      'PRAGMA foreign_keys = OFF;',
      '',
      'DROP INDEX IF EXISTS idx_member_profile_chars_profile;',
      'DROP INDEX IF EXISTS idx_member_profiles_user_id;',
      'DROP TABLE IF EXISTS member_profile_characters;',
      'DROP TABLE IF EXISTS member_profiles;',
      '',
    ];

    if (needsSimReconcile) {
      statements.push(`DROP INDEX IF EXISTS idx_sim_item_winners_run;
DROP INDEX IF EXISTS idx_sim_item_winners_run_char;
DROP INDEX IF EXISTS idx_sim_raider_summaries_run_char;
DROP INDEX IF EXISTS idx_sim_runs_status_updated;
DROP INDEX IF EXISTS idx_sim_runs_team_difficulty_created;
DROP INDEX IF EXISTS idx_sim_runs_team_diff_updated;

DROP TABLE IF EXISTS sim_item_winners;
DROP TABLE IF EXISTS sim_raider_summaries;
DROP TABLE IF EXISTS sim_runs;

CREATE TABLE sim_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id               TEXT    NOT NULL,
    roster_revision      TEXT,
    site_team_id         INTEGER NOT NULL,
    difficulty           TEXT    NOT NULL DEFAULT 'mythic',
    status               TEXT    NOT NULL DEFAULT 'finished' CHECK (status IN ('queued', 'running', 'finished', 'failed')),
    started_at_utc       TEXT,
    finished_at_utc      TEXT,
    last_heartbeat_utc   TEXT,
    simc_version         TEXT,
    runner_version       TEXT,
    error_message        TEXT,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (run_id, site_team_id),
    FOREIGN KEY (site_team_id) REFERENCES raid_teams(id) ON DELETE CASCADE
);

CREATE TABLE sim_raider_summaries (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_run_id           INTEGER NOT NULL,
    blizzard_char_id     INTEGER NOT NULL,
    baseline_dps         REAL,
    top_scenario         TEXT,
    top_dps              REAL,
    gain_dps             REAL,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (sim_run_id) REFERENCES sim_runs(id) ON DELETE CASCADE
);

CREATE TABLE sim_item_winners (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_run_id            INTEGER NOT NULL,
    slot                  TEXT    NOT NULL,
    item_id               INTEGER,
    item_label            TEXT,
    ilvl                  INTEGER,
    source                TEXT,
    best_blizzard_char_id INTEGER,
    delta_dps             REAL,
    pct_gain              REAL,
    simc                  TEXT,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (sim_run_id) REFERENCES sim_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_sim_runs_team_diff_updated ON sim_runs(site_team_id, difficulty, updated_at DESC);
CREATE INDEX idx_sim_runs_status_updated ON sim_runs(status, updated_at DESC);
CREATE INDEX idx_sim_raider_summaries_run_char ON sim_raider_summaries(sim_run_id, blizzard_char_id);
CREATE INDEX idx_sim_item_winners_run_char ON sim_item_winners(sim_run_id, best_blizzard_char_id);
CREATE INDEX idx_sim_item_winners_run ON sim_item_winners(sim_run_id);`);
    } else {
      statements.push('DROP INDEX IF EXISTS idx_sim_runs_team_difficulty_created;');
      statements.push('CREATE INDEX IF NOT EXISTS idx_sim_runs_team_diff_updated ON sim_runs(site_team_id, difficulty, updated_at DESC);');
    }

    statements.push('');
    statements.push('PRAGMA foreign_keys = ON;');
    statements.push('COMMIT;');

    runLocalSqlFile(statements.join('\n'));
    console.log('Local schema reconciled.');
  } catch (error) {
    console.error(`Reconciliation failed: ${error.message}`);
    process.exit(1);
  }
}

main();