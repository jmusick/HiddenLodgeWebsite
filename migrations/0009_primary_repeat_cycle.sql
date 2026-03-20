-- Hidden Lodge DB: add repeat cycle support for primary raid schedules
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0009_primary_repeat_cycle.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0009_primary_repeat_cycle.sql

ALTER TABLE primary_raid_schedules ADD COLUMN repeat_cycle TEXT NOT NULL DEFAULT 'weekly';

UPDATE primary_raid_schedules
SET repeat_cycle = 'weekly'
WHERE repeat_cycle IS NULL OR repeat_cycle = '';

CREATE INDEX IF NOT EXISTS idx_primary_raid_schedules_repeat
ON primary_raid_schedules(is_active, repeat_cycle, weekday_utc, start_time_utc);
