-- Hidden Lodge DB: add a configurable week-to-week gear-upgrade weight to Raid Comp.
-- Run locally:  npm run db:migrate:local -- migrations/0095_raid_comp_upgrades_weight.sql
-- Run in prod:  npm run db:migrate:prod -- migrations/0095_raid_comp_upgrades_weight.sql

ALTER TABLE raid_comp_settings ADD COLUMN upgrades_weight INTEGER NOT NULL DEFAULT 0 CHECK (upgrades_weight BETWEEN 0 AND 100);
