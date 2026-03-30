-- Hidden Lodge DB: world vault weekly objective snapshot tracking
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0042_world_vault_weekly_snapshot.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0042_world_vault_weekly_snapshot.sql

ALTER TABLE raider_metrics_cache ADD COLUMN world_vault_weekly_objectives INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN world_vault_quantity_snapshot INTEGER;
