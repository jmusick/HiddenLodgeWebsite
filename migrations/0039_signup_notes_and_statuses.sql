-- Hidden Lodge DB: add signup notes and extend statuses (late, absent)
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0039_signup_notes_and_statuses.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0039_signup_notes_and_statuses.sql

-- Update the CHECK constraint to allow new statuses: late and absent
-- Note: SQLite doesn't support direct constraint modification, so we recreate the table
-- This is a safe operation since we're preserving all data

CREATE TABLE raid_signups_new (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id         INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    raid_kind            TEXT    NOT NULL CHECK (raid_kind IN ('primary', 'adhoc')),
    primary_schedule_id  INTEGER REFERENCES primary_raid_schedules(id) ON DELETE CASCADE,
    ad_hoc_raid_id       INTEGER REFERENCES ad_hoc_raids(id) ON DELETE CASCADE,
    occurrence_start_utc INTEGER,
    signup_status        TEXT NOT NULL DEFAULT 'coming' CHECK (signup_status IN ('coming', 'tentative', 'late', 'absent')),
    signup_role          TEXT NOT NULL DEFAULT 'ranged-dps' CHECK (signup_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps')),
    signed_up_at         INTEGER NOT NULL DEFAULT 0,
    signup_notes         TEXT,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (
        (raid_kind = 'primary' AND primary_schedule_id IS NOT NULL AND ad_hoc_raid_id IS NULL AND occurrence_start_utc IS NOT NULL)
        OR
        (raid_kind = 'adhoc' AND ad_hoc_raid_id IS NOT NULL AND primary_schedule_id IS NULL AND occurrence_start_utc IS NULL)
    )
);

INSERT INTO raid_signups_new
SELECT 
    id,
    user_id,
    character_id,
    raid_kind,
    primary_schedule_id,
    ad_hoc_raid_id,
    occurrence_start_utc,
    signup_status,
    signup_role,
    signed_up_at,
    NULL,
    created_at,
    COALESCE(updated_at, unixepoch())
FROM raid_signups;

DROP TABLE raid_signups;
ALTER TABLE raid_signups_new RENAME TO raid_signups;

-- Recreate indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_signups_primary
ON raid_signups(user_id, primary_schedule_id, occurrence_start_utc)
WHERE primary_schedule_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_signups_adhoc
ON raid_signups(user_id, ad_hoc_raid_id)
WHERE ad_hoc_raid_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raid_signups_status
ON raid_signups(user_id, signup_status, created_at);

CREATE INDEX IF NOT EXISTS idx_raid_signups_role
ON raid_signups(user_id, signup_role, created_at);

CREATE INDEX IF NOT EXISTS idx_raid_signups_signed_up_at
ON raid_signups(raid_kind, primary_schedule_id, ad_hoc_raid_id, occurrence_start_utc, signed_up_at);
