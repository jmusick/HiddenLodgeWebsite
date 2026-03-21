-- Hidden Lodge DB: add total missing upgrade tracks to raiders cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0020_missing_upgrades.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0020_missing_upgrades.sql

ALTER TABLE raider_metrics_cache ADD COLUMN total_upgrades_missing INTEGER;
