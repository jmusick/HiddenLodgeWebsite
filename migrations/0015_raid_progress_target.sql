-- Hidden Lodge DB: add tracked raid name field to raiders cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0015_raid_progress_target.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0015_raid_progress_target.sql

ALTER TABLE raider_metrics_cache ADD COLUMN raid_progress_raid_name TEXT;