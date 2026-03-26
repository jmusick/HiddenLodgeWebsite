-- Hidden Lodge DB: Raider.IO weekly Mythic+ dungeon counts
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0031_mythic_plus_weekly_runs.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0031_mythic_plus_weekly_runs.sql

ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_weekly_runs INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_prev_weekly_runs INTEGER;
