-- Hidden Lodge DB: keep each equipped item's Blizzard bonus_list on the gear cache.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0068_gear_bonus_ids.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0068_gear_bonus_ids.sql

-- Without the bonus ids a Wowhead link resolves to the item's default (max)
-- rendition, so the grid's tooltip claimed "Myth 6/6" for a Hero 3/6 drop.
-- Existing rows default to an empty list and pick up real values as each
-- raider's details TTL rolls over.
ALTER TABLE raider_gear_cache ADD COLUMN bonus_list_json TEXT NOT NULL DEFAULT '[]';
