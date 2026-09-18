-- Hidden Lodge DB: no schema change. Rows cached in death_cooldown_cache
-- before the "not_tracked" status was introduced (src/lib/death-cooldowns.ts)
-- still hold health_potion_status = 'unknown' from when HEALTH_POTION was
-- unset, which is indistinguishable in the UI from a real lookup failure.
-- Clear the cache so every death recomputes on next expand and gets the
-- correct 'not_tracked' status; the cache is disposable and cheap to refill
-- (one lazy WCL query per death, same as item_icon_cache's purge pattern in
-- migrations/0070_purge_dead_item_icon_urls.sql).
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0082_death_cooldown_cache_potion_status_fix.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0082_death_cooldown_cache_potion_status_fix.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
