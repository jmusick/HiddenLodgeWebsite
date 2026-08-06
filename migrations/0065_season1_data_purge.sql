-- Hidden Lodge DB: purge Midnight Season 1 raider tracking data ahead of Season 2 (starts 2026-08-18 01:00 ET).
-- Wipes weekly/history tracking tables plus the "current" gear/M+/vault columns on
-- raider_metrics_cache, so the Raiders page shows a clean slate until the first
-- post-Season-2-start refresh repopulates everything. Roster identity columns
-- (name/realm/class/team_names/auth_state) and OAuth token state are left alone.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0065_season1_data_purge.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0065_season1_data_purge.sql
--
-- IMPORTANT: take a full export first so this is recoverable if needed — none of the
-- tables touched here are in PROTECTED_TABLES, so the migration runner's automatic
-- protected-table backup will NOT cover them. Back up manually before running.
--
-- allow-destructive

DELETE FROM raider_vault_history;
DELETE FROM raider_preparedness_history;
DELETE FROM raider_progression_history;
DELETE FROM raider_keystones;

UPDATE raider_metrics_cache
SET
  -- Live gear/prep snapshot
  equipped_item_level = NULL,
  average_item_level = NULL,
  mythic_score = NULL,
  tier_pieces_equipped = NULL,
  socketed_gems = NULL,
  total_sockets = NULL,
  enchanted_slots = NULL,
  enchantable_slots = NULL,
  total_upgrades_missing = NULL,

  -- Crests
  adventurer_crests = NULL,
  veteran_crests = NULL,
  champion_crests = NULL,
  hero_crests = NULL,
  myth_crests = NULL,

  -- Raid progress (Season 1 raid tier)
  raid_progress_raid_name = NULL,
  raid_progress_label = NULL,
  raid_progress_kills = NULL,
  raid_progress_total = NULL,

  -- Mythic+ run counts / vault
  mythic_plus_run_count = NULL,
  mythic_plus_weekly_runs = NULL,
  mythic_plus_prev_weekly_runs = NULL,
  mythic_plus_season_runs = NULL,
  mythic_plus_vault_ilvl_1 = NULL,
  mythic_plus_vault_ilvl_2 = NULL,
  mythic_plus_vault_ilvl_3 = NULL,
  mythic_plus_quantity_snapshot = NULL,

  -- World (Delves) vault
  world_vault_weekly_objectives = NULL,
  world_vault_quantity_snapshot = NULL,

  -- Preparedness rolling averages (derived from raider_preparedness_history, now empty)
  avg_30d_socketed_gems = NULL,
  avg_30d_total_sockets = NULL,
  avg_30d_enchanted_slots = NULL,
  avg_30d_enchantable_slots = NULL,
  preparedness_history_synced_at = NULL,

  -- Force every raider back into the detail-refresh queue once Season 2 starts
  details_synced_at = NULL;
