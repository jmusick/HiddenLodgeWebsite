-- Hidden Lodge DB: repair missing sim result tables when older 0024 variant only created sim_runs
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0027_repair_sim_result_tables.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0027_repair_sim_result_tables.sql

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

CREATE INDEX IF NOT EXISTS idx_sim_raider_summaries_run_char ON sim_raider_summaries(sim_run_id, blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_sim_item_winners_run_char ON sim_item_winners(sim_run_id, best_blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_sim_item_winners_run ON sim_item_winners(sim_run_id);
