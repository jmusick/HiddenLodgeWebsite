-- Hidden Lodge DB: Season 2 death analysis, sourced straight from the guild's
-- Warcraft Logs report list (no dependency on raid signups/schedules).
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0074_death_analysis.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0074_death_analysis.sql

-- One row per guild report that overlaps a Thu/Fri raid window. Reports with
-- zero qualifying pulls are kept too so the sync doesn't refetch them.
CREATE TABLE IF NOT EXISTS death_analysis_reports (
    report_code       TEXT    PRIMARY KEY,
    night_key         TEXT    NOT NULL,
    report_start_utc  INTEGER NOT NULL,
    report_end_utc    INTEGER NOT NULL,
    boss_pulls        INTEGER NOT NULL DEFAULT 0,
    boss_kills        INTEGER NOT NULL DEFAULT 0,
    synced_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_death_analysis_reports_night
ON death_analysis_reports(night_key);

CREATE TABLE IF NOT EXISTS death_analysis_stats (
    report_code         TEXT    NOT NULL REFERENCES death_analysis_reports(report_code) ON DELETE CASCADE,
    blizzard_char_id    INTEGER NOT NULL,
    fights_present      INTEGER NOT NULL DEFAULT 0,
    total_deaths        INTEGER NOT NULL DEFAULT 0,
    first_death_count   INTEGER NOT NULL DEFAULT 0,
    second_death_count  INTEGER NOT NULL DEFAULT 0,
    third_death_count   INTEGER NOT NULL DEFAULT 0,
    fourth_death_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_code, blizzard_char_id)
);

-- Officer-chosen canonical report for a raid night when several people logged it.
CREATE TABLE IF NOT EXISTS death_analysis_night_overrides (
    night_key           TEXT    PRIMARY KEY,
    report_code         TEXT    NOT NULL,
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
