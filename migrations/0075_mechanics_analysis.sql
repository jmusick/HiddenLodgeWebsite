-- Hidden Lodge DB: per-boss mechanic leaderboards (e.g. Coiled Altar orb carries),
-- computed from the same canonical raid-night reports Death Analysis counts.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0075_mechanics_analysis.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0075_mechanics_analysis.sql

-- One row per (report, mechanic) once that mechanic has been synced for the
-- report — the don't-refetch cursor. Kept even when the boss wasn't pulled.
CREATE TABLE IF NOT EXISTS mechanics_analysis_reports (
    report_code   TEXT    NOT NULL,
    mechanic_key  TEXT    NOT NULL,
    pulls         INTEGER NOT NULL DEFAULT 0,
    synced_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (report_code, mechanic_key)
);

CREATE TABLE IF NOT EXISTS mechanics_analysis_stats (
    report_code       TEXT    NOT NULL,
    mechanic_key      TEXT    NOT NULL,
    blizzard_char_id  INTEGER NOT NULL,
    -- tank | healer | melee | ranged: the spec played in most of this report's
    -- pulls of the boss (from WCL CombatantInfo specID); NULL if unknown.
    role              TEXT,
    pulls_present     INTEGER NOT NULL DEFAULT 0,
    pulls_hit         INTEGER NOT NULL DEFAULT 0,
    hit_count         INTEGER NOT NULL DEFAULT 0,
    best_pull_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_code, mechanic_key, blizzard_char_id)
);
