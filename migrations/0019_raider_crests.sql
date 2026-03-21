-- Hidden Lodge DB: add crest counters to raiders cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0019_raider_crests.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0019_raider_crests.sql

ALTER TABLE raider_metrics_cache ADD COLUMN adventurer_crests INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN veteran_crests INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN champion_crests INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN hero_crests INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN myth_crests INTEGER;