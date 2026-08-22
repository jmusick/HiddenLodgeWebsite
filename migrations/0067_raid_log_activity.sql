-- Hidden Lodge DB: recent Warcraft Logs activity + tier-set flag on cached gear
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0067_raid_log_activity.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0067_raid_log_activity.sql

-- One row per guild report we have already pulled the participant list from.
-- Acts as the "don't refetch" cursor for the log-activity sync: each refresh
-- only spends WCL calls on report codes that aren't in here yet.
CREATE TABLE IF NOT EXISTS raid_log_reports_seen (
    report_code       TEXT    PRIMARY KEY,
    report_start_utc  INTEGER NOT NULL,
    report_end_utc    INTEGER NOT NULL,
    participant_count INTEGER NOT NULL DEFAULT 0,
    processed_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raid_log_reports_seen_start
ON raid_log_reports_seen(report_start_utc);

-- Last time each roster character appeared as a player in a guild report.
-- Drives the "active in the last 30 days" default filter on /raiders and
-- /raiders/gear-summary.
CREATE TABLE IF NOT EXISTS raider_log_activity (
    blizzard_char_id  INTEGER PRIMARY KEY,
    last_seen_log_utc INTEGER NOT NULL,
    last_report_code  TEXT,
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raider_log_activity_last_seen
ON raider_log_activity(last_seen_log_utc);

-- Tier-set membership per equipped item, so the gear grid can badge tier pieces
-- without re-deriving set data at render time. Existing rows default to 0 and
-- pick up the real value as each raider's details TTL rolls over.
ALTER TABLE raider_gear_cache ADD COLUMN is_tier_set INTEGER NOT NULL DEFAULT 0;
