-- Hidden Lodge DB: no schema change. death-cooldowns.ts now treats
-- Silvermoon Health Potion and Potent Healing Potion as sharing one
-- cooldown (casting either puts both on cooldown, confirmed by the guild),
-- rather than tracking each potion's cast history independently. Rows
-- cached before this fix under-count how often potions were on cooldown.
-- Clear the cache so every death recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0084_death_cooldown_cache_potion_shared_cd.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0084_death_cooldown_cache_potion_shared_cd.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
