-- Hidden Lodge DB: no schema change. Corrects the previous "mage barriers
-- have no cooldown" conclusion in src/lib/defensive-cooldowns.ts — the
-- sub-second cast gaps used as evidence were charge-spending (barriers
-- commonly have 2 charges via an Improved-* talent), not proof of no
-- cooldown. A patch note confirms all three barriers share a 30s-per-charge
-- cooldown. Added per-spec: Ice Barrier (Frost), Blazing Barrier (Fire),
-- Prismatic Barrier (Arcane), via SPEC_OVERRIDES. Clear the cache so every
-- death recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0088_death_cooldown_cache_mage_barriers.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0088_death_cooldown_cache_mage_barriers.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
