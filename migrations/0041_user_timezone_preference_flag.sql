-- Hidden Lodge DB: distinguish explicit timezone choices from legacy default values
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0041_user_timezone_preference_flag.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0041_user_timezone_preference_flag.sql

ALTER TABLE users ADD COLUMN time_zone_set INTEGER NOT NULL DEFAULT 0 CHECK (time_zone_set IN (0, 1));

-- Preserve known explicit selections from existing records.
UPDATE users
SET time_zone_set = 1
WHERE time_zone IS NOT NULL
  AND TRIM(time_zone) <> ''
  AND time_zone <> 'UTC';
