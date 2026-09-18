-- Hidden Lodge DB: no schema change. Ice Cold is a talent choice that
-- replaces Ice Block (confirmed by the user) — a Mage only ever has one of
-- the two, never both. Without talent data from WCL we can't tell which one
-- a given player has, so src/lib/defensive-cooldowns.ts now links them with
-- a shared cooldownGroup: whichever one actually gets cast drives both
-- entries' status, instead of the untalented one sitting at a false
-- "Available" forever because it's never cast. Rows already cached don't
-- reflect this. Clear the cache so every death recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0089_death_cooldown_cache_ice_block_ice_cold.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0089_death_cooldown_cache_ice_block_ice_cold.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
