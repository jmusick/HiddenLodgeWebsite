-- Hidden Lodge DB: configurable Parse, Death, Great Vault, and Preparedness weights for Raid Comp.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0094_raid_comp_additional_scores.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0094_raid_comp_additional_scores.sql

-- Keep existing officers' Parse/Death split exactly as it was until they save a new four-input configuration.
ALTER TABLE raid_comp_settings ADD COLUMN parse_weight INTEGER NOT NULL DEFAULT 60 CHECK (parse_weight BETWEEN 0 AND 100);
ALTER TABLE raid_comp_settings ADD COLUMN death_weight INTEGER NOT NULL DEFAULT 40 CHECK (death_weight BETWEEN 0 AND 100);
ALTER TABLE raid_comp_settings ADD COLUMN vault_weight INTEGER NOT NULL DEFAULT 0 CHECK (vault_weight BETWEEN 0 AND 100);
ALTER TABLE raid_comp_settings ADD COLUMN preparedness_weight INTEGER NOT NULL DEFAULT 0 CHECK (preparedness_weight BETWEEN 0 AND 100);

UPDATE raid_comp_settings
SET parse_weight = weight,
    death_weight = 100 - weight,
    vault_weight = 0,
    preparedness_weight = 0;
