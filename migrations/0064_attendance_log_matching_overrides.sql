-- Hidden Lodge DB: attendance log matching overrides for officer/admin manual report selection
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0064_attendance_log_matching_overrides.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0064_attendance_log_matching_overrides.sql

CREATE TABLE IF NOT EXISTS raid_attendance_log_overrides (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_ref_key         TEXT    NOT NULL,
    occurrence_start_utc INTEGER NOT NULL,
    report_code          TEXT    NOT NULL,
    created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_attendance_log_overrides_occurrence
ON raid_attendance_log_overrides(raid_ref_key, occurrence_start_utc);

CREATE INDEX IF NOT EXISTS idx_raid_attendance_log_overrides_updated
ON raid_attendance_log_overrides(updated_at DESC);
