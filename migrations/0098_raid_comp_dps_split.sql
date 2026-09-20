-- Raid Comp: persist independent melee and ranged DPS targets.
-- Run locally: npm run db:migrate:local -- migrations/0098_raid_comp_dps_split.sql

ALTER TABLE raid_comp_settings ADD COLUMN melee_dps_quota INTEGER NOT NULL DEFAULT 7 CHECK (melee_dps_quota BETWEEN 0 AND 40);
ALTER TABLE raid_comp_settings ADD COLUMN ranged_dps_quota INTEGER NOT NULL DEFAULT 6 CHECK (ranged_dps_quota BETWEEN 0 AND 40);

-- Preserve the previous automatic split for every existing saved comp.
UPDATE raid_comp_settings
SET melee_dps_quota = (dps_quota + 1) / 2,
    ranged_dps_quota = dps_quota / 2;
