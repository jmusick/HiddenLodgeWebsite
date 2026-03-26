-- Hidden Lodge DB: Great Vault slot ilvl tracking and season M+ run accumulation
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0032_mythic_plus_vault.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0032_mythic_plus_vault.sql

-- Accumulated M+ completions from past weeks only (not including the current week).
-- Season total = mythic_plus_season_runs + mythic_plus_weekly_runs.
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_season_runs INTEGER;

-- Great Vault M+ slot ilvl earned this week (null if slot not unlocked).
-- Slot 1 requires 1 keystone dungeon, slot 2 requires 4, slot 3 requires 8.
-- Values derived from key levels in Raider.IO weekly highest-level runs.
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_vault_ilvl_1 INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_vault_ilvl_2 INTEGER;
ALTER TABLE raider_metrics_cache ADD COLUMN mythic_plus_vault_ilvl_3 INTEGER;
