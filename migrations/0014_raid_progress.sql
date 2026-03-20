-- Hidden Lodge DB: add raid progress fields to raiders cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0014_raid_progress.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0014_raid_progress.sql

ALTER TABLE raider_metrics_cache ADD COLUMN raid_progress_label TEXT;
ALTER TABLE raider_metrics_cache ADD COLUMN raid_progress_kills INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN raid_progress_total INTEGER;
