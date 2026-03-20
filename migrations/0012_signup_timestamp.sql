-- Hidden Lodge DB: track exact signup timestamp for ordering in raid summaries
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0012_signup_timestamp.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0012_signup_timestamp.sql

ALTER TABLE raid_signups ADD COLUMN signed_up_at INTEGER NOT NULL DEFAULT 0;

UPDATE raid_signups
SET signed_up_at = COALESCE(created_at, unixepoch())
WHERE signed_up_at IS NULL OR signed_up_at = 0;

CREATE INDEX IF NOT EXISTS idx_raid_signups_signed_up_at
ON raid_signups(raid_kind, primary_schedule_id, ad_hoc_raid_id, occurrence_start_utc, signed_up_at);