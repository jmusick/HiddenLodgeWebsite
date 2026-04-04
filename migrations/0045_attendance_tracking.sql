-- Hidden Lodge DB: attendance tracking (WCL sync + officer bench overrides)
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0045_attendance_tracking.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0045_attendance_tracking.sql

CREATE TABLE IF NOT EXISTS raid_attendance_reports (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_ref_key         TEXT    NOT NULL,
    raid_kind            TEXT    NOT NULL CHECK (raid_kind IN ('primary', 'adhoc')),
    primary_schedule_id  INTEGER REFERENCES primary_raid_schedules(id) ON DELETE CASCADE,
    ad_hoc_raid_id       INTEGER REFERENCES ad_hoc_raids(id) ON DELETE CASCADE,
    occurrence_start_utc INTEGER NOT NULL,
    report_code          TEXT,
    report_start_utc     INTEGER,
    report_end_utc       INTEGER,
    total_boss_kills     INTEGER NOT NULL DEFAULT 0,
    synced_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (
        (raid_kind = 'primary' AND primary_schedule_id IS NOT NULL AND ad_hoc_raid_id IS NULL)
        OR
        (raid_kind = 'adhoc' AND ad_hoc_raid_id IS NOT NULL AND primary_schedule_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_attendance_reports_occurrence
ON raid_attendance_reports(raid_ref_key, occurrence_start_utc);

CREATE TABLE IF NOT EXISTS raid_attendance_participants (
    report_id         INTEGER NOT NULL REFERENCES raid_attendance_reports(id) ON DELETE CASCADE,
    blizzard_char_id  INTEGER NOT NULL,
    bosses_present    INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (report_id, blizzard_char_id)
);

CREATE INDEX IF NOT EXISTS idx_raid_attendance_participants_char
ON raid_attendance_participants(blizzard_char_id, report_id);

CREATE TABLE IF NOT EXISTS raid_attendance_overrides (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_ref_key         TEXT    NOT NULL,
    raid_kind            TEXT    NOT NULL CHECK (raid_kind IN ('primary', 'adhoc')),
    primary_schedule_id  INTEGER REFERENCES primary_raid_schedules(id) ON DELETE CASCADE,
    ad_hoc_raid_id       INTEGER REFERENCES ad_hoc_raids(id) ON DELETE CASCADE,
    occurrence_start_utc INTEGER NOT NULL,
    blizzard_char_id     INTEGER NOT NULL,
    override_kind        TEXT    NOT NULL CHECK (override_kind IN ('bench')),
    note                 TEXT,
    created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (
        (raid_kind = 'primary' AND primary_schedule_id IS NOT NULL AND ad_hoc_raid_id IS NULL)
        OR
        (raid_kind = 'adhoc' AND ad_hoc_raid_id IS NOT NULL AND primary_schedule_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_attendance_overrides_entry
ON raid_attendance_overrides(raid_ref_key, occurrence_start_utc, blizzard_char_id, override_kind);

CREATE INDEX IF NOT EXISTS idx_raid_attendance_overrides_char
ON raid_attendance_overrides(blizzard_char_id, occurrence_start_utc);
