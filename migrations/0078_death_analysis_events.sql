-- Hidden Lodge DB: per-death event rows (report, fight, offset into the pull)
-- for Death Analysis, so raiders can expand a ranking row into direct WCL
-- links to review why each death happened.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0078_death_analysis_events.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0078_death_analysis_events.sql

-- One row per counted death (capped at the first four per pull, matching the
-- death_analysis_stats scoring cap). death_position is a report-wide counter
-- per fight, so it's unique within (report_code, fight_id) on its own.
CREATE TABLE IF NOT EXISTS death_analysis_events (
    report_code       TEXT    NOT NULL REFERENCES death_analysis_reports(report_code) ON DELETE CASCADE,
    fight_id          INTEGER NOT NULL,
    death_position    INTEGER NOT NULL,
    blizzard_char_id  INTEGER NOT NULL,
    encounter_id      INTEGER NOT NULL,
    encounter_name    TEXT    NOT NULL DEFAULT '',
    death_offset_ms   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_code, fight_id, death_position)
);

CREATE INDEX IF NOT EXISTS idx_death_analysis_events_char
ON death_analysis_events(blizzard_char_id);

-- Backfill: force every already-synced report to be re-pulled by the death
-- analysis cron so existing raid nights get death-link data too, not just
-- reports synced from here on.
UPDATE death_analysis_reports SET synced_at = 0;
