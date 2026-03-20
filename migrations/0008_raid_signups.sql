-- Hidden Lodge DB: raid signup schedules, ad-hoc raids, signups, and user timezone
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0008_raid_signups.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0008_raid_signups.sql

ALTER TABLE users ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';

CREATE TABLE IF NOT EXISTS primary_raid_schedules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    weekday_utc      INTEGER NOT NULL CHECK (weekday_utc BETWEEN 0 AND 6),
    start_time_utc   TEXT    NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 180,
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ad_hoc_raids (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    starts_at_utc    INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 180,
    notes            TEXT,
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS raid_signups (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id         INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    raid_kind            TEXT    NOT NULL CHECK (raid_kind IN ('primary', 'adhoc')),
    primary_schedule_id  INTEGER REFERENCES primary_raid_schedules(id) ON DELETE CASCADE,
    ad_hoc_raid_id       INTEGER REFERENCES ad_hoc_raids(id) ON DELETE CASCADE,
    occurrence_start_utc INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (
        (raid_kind = 'primary' AND primary_schedule_id IS NOT NULL AND ad_hoc_raid_id IS NULL AND occurrence_start_utc IS NOT NULL)
        OR
        (raid_kind = 'adhoc' AND ad_hoc_raid_id IS NOT NULL AND primary_schedule_id IS NULL AND occurrence_start_utc IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_signups_primary
ON raid_signups(user_id, primary_schedule_id, occurrence_start_utc)
WHERE primary_schedule_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_signups_adhoc
ON raid_signups(user_id, ad_hoc_raid_id)
WHERE ad_hoc_raid_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_primary_raid_schedules_active
ON primary_raid_schedules(is_active, weekday_utc, start_time_utc);

CREATE INDEX IF NOT EXISTS idx_ad_hoc_raids_active_start
ON ad_hoc_raids(is_active, starts_at_utc);

CREATE INDEX IF NOT EXISTS idx_raid_signups_user
ON raid_signups(user_id, created_at);
