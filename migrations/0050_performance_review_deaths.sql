-- Hidden Lodge DB: persisted death-review metrics for admin performance review
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0050_performance_review_deaths.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0050_performance_review_deaths.sql

ALTER TABLE raid_attendance_reports ADD COLUMN total_boss_fights INTEGER NOT NULL DEFAULT 0;
ALTER TABLE raid_attendance_reports ADD COLUMN death_stats_synced_at INTEGER;

CREATE TABLE IF NOT EXISTS raid_attendance_death_stats (
    report_id           INTEGER NOT NULL REFERENCES raid_attendance_reports(id) ON DELETE CASCADE,
    blizzard_char_id    INTEGER NOT NULL,
    fights_present      INTEGER NOT NULL DEFAULT 0,
    total_deaths        INTEGER NOT NULL DEFAULT 0,
    first_death_count   INTEGER NOT NULL DEFAULT 0,
    second_death_count  INTEGER NOT NULL DEFAULT 0,
    third_death_count   INTEGER NOT NULL DEFAULT 0,
    fourth_death_count  INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (report_id, blizzard_char_id)
);

CREATE INDEX IF NOT EXISTS idx_raid_attendance_death_stats_char
ON raid_attendance_death_stats(blizzard_char_id, report_id);