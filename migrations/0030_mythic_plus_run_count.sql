-- Hidden Lodge DB: Raider.IO Mythic+ run count cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0030_mythic_plus_run_count.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0030_mythic_plus_run_count.sql

ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_run_count INTEGER;
