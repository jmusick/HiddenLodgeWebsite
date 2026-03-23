-- Hidden Lodge DB: simulation runs and recommendation winners
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0024_sim_runs.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0024_sim_runs.sql

CREATE TABLE IF NOT EXISTS sim_runs (
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

CREATE TABLE IF NOT EXISTS sim_raider_summaries (
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

CREATE TABLE IF NOT EXISTS sim_item_winners (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_run_id           INTEGER NOT NULL,
    slot                 TEXT    NOT NULL,
    item_id              INTEGER,
    item_label           TEXT,
    ilvl                 INTEGER,
    source               TEXT,
    best_blizzard_char_id INTEGER,
    delta_dps            REAL,
    pct_gain             REAL,
    simc                 TEXT,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (sim_run_id) REFERENCES sim_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sim_runs_team_diff_updated ON sim_runs(site_team_id, difficulty, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_runs_status_updated ON sim_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_raider_summaries_run_char ON sim_raider_summaries(sim_run_id, blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_sim_item_winners_run_char ON sim_item_winners(sim_run_id, best_blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_sim_item_winners_run ON sim_item_winners(sim_run_id);
