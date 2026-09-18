-- Hidden Lodge DB: replaces the fixed healthstone/health-potion columns on
-- death_cooldown_cache with a single consumables_json column (same shape as
-- defensives_json), because it turns out raiders use more than one healing
-- potion (Silvermoon Health Potion and Potent Healing Potion both showed up
-- in real Casts data for this guild's reports) and a single "health potion"
-- slot can't represent that. See src/lib/defensive-cooldowns.ts.
-- The old healthstone_status/health_potion_status columns are left in place
-- (dropping columns needs --allow-destructive and isn't worth it for a
-- disposable cache) but are no longer read or written.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0083_death_cooldown_cache_consumables.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0083_death_cooldown_cache_consumables.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

ALTER TABLE death_cooldown_cache ADD COLUMN consumables_json TEXT NOT NULL DEFAULT '[]';

DELETE FROM death_cooldown_cache;
