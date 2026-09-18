-- Hidden Lodge DB: no schema change. Fixes several spec-exclusivity errors
-- in src/lib/defensive-cooldowns.ts, all confirmed against Wowhead/real
-- cast data:
--   - Vampiric Blood is Blood-only, was shown for Frost/Unholy too.
--   - Survival Instincts and Frenzied Regeneration are Feral/Guardian only,
--     were shown for Balance/Restoration too.
--   - Dispersion is Shadow-only, was shown for Discipline/Holy too.
--   - Added Mage's Ice Cold and Alter Time (class-wide, real cooldowns).
-- Rows already cached show wrong abilities for the wrong spec. Clear the
-- cache so every death recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0087_death_cooldown_cache_spec_fixes.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0087_death_cooldown_cache_spec_fixes.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
