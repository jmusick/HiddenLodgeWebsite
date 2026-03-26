-- Hidden Lodge DB: Blizzard achievement stat quantity snapshot for true weekly M+ run counts
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0033_mythic_plus_quantity_snapshot.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0033_mythic_plus_quantity_snapshot.sql

-- Stores the sum of Blizzard achievement stat `quantity` values for all Season 16 tracked
-- dungeons, captured at the start of each week. Weekly run count = current lifetime total
-- minus this snapshot, giving true runs done (not capped at 8).
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_quantity_snapshot INTEGER;
