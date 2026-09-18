-- Hidden Lodge DB: no schema change. Added Survival of the Fittest
-- (spell 264735, 3 min cooldown, baseline for all Hunter specs) to the
-- Hunter defensive list in src/lib/defensive-cooldowns.ts. Rows already
-- cached for Hunter deaths won't include it. Clear the cache so every death
-- recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0085_death_cooldown_cache_hunter_defensive.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0085_death_cooldown_cache_hunter_defensive.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
