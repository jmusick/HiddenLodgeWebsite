-- Hidden Lodge DB: weekly Great Vault history snapshots
-- Captures per-raider vault status for each reset week (US Tuesday reset bucket).
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0043_vault_history.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0043_vault_history.sql

CREATE TABLE IF NOT EXISTS raider_vault_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blizzard_char_id INTEGER NOT NULL,
  week_start_ts INTEGER NOT NULL,
  week_end_ts INTEGER NOT NULL,
  snapshot_ts INTEGER NOT NULL,
  raid_weekly_boss_kills INTEGER,
  raid_slot_1_ilvl INTEGER,
  raid_slot_2_ilvl INTEGER,
  raid_slot_3_ilvl INTEGER,
  dungeon_slot_1_ilvl INTEGER,
  dungeon_slot_2_ilvl INTEGER,
  dungeon_slot_3_ilvl INTEGER,
  world_weekly_objectives INTEGER,
  raid_slots_filled INTEGER NOT NULL DEFAULT 0,
  dungeon_slots_filled INTEGER NOT NULL DEFAULT 0,
  world_slots_filled INTEGER NOT NULL DEFAULT 0,
  total_slots_filled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(blizzard_char_id, week_start_ts)
);

CREATE INDEX IF NOT EXISTS idx_vault_history_char_week ON raider_vault_history(blizzard_char_id, week_start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_vault_history_week ON raider_vault_history(week_start_ts DESC);
