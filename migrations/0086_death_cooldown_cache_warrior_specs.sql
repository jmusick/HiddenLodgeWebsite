-- Hidden Lodge DB: no schema change. Fixes two errors in
-- src/lib/defensive-cooldowns.ts's Warrior defensives: Shield Wall
-- (Protection-only, since patch 6.0.2) was being shown as available to
-- Arms/Fury Warriors too, and its cooldown was wrong (180s, not 240s).
-- Die by the Sword (Arms/Fury-only) was being shown for Protection.
-- Added a per-spec override mechanism (SPEC_OVERRIDES) so a class's shared
-- defensive list can exclude spec-locked abilities per spec. Rows cached
-- before this fix show the wrong ability for the wrong spec. Clear the
-- cache so every death recomputes on next expand.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0086_death_cooldown_cache_warrior_specs.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0086_death_cooldown_cache_warrior_specs.sql
-- allow-destructive: death_cooldown_cache is a disposable, lazily-refilled cache.

DELETE FROM death_cooldown_cache;
