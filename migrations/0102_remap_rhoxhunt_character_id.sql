-- allow-destructive
-- Hidden Lodge DB: Rhoxtar's Hunter alt was renamed + race changed (Undead
-- "Tummysnakes" -> Dwarf "Rhoxhunt"), which Blizzard tracks as a new
-- character id rather than an in-place rename:
--   232758336 (stale, Tummysnakes, Undead, Horde)
--   237938848 (current, Rhoxhunt, Dwarf, Alliance) - confirmed via the
--   Blizzard guild roster API and https://us.api.blizzard.com/profile/wow/character/thrall/rhoxhunt
-- Every table keyed on blizzard_char_id is remapped old -> new so existing
-- history (deaths, keystones, vault, gear, attendance) stays attached to the
-- same player instead of orphaning under a name that no longer exists.
-- Idempotent: guarded UPDATEs skip a row whose target already exists, and the
-- trailing DELETEs retire whatever's left under the stale id (mirrors the
-- pattern in 0076_remap_stale_wcl_character_ids.sql).
-- Run locally: npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0102_remap_rhoxhunt_character_id.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0102_remap_rhoxhunt_character_id.sql

-- characters: turn the stale row into the current one if no current row
-- exists yet (e.g. local dev DB); otherwise the current row already exists
-- (prod, synced by a later login) and the stale row is dropped below.
UPDATE characters
SET blizzard_char_id = 237938848,
    name = 'Rhoxhunt',
    realm = 'Thrall',
    realm_slug = 'thrall',
    class_name = 'Hunter',
    race_name = 'Dwarf',
    faction = 'Alliance',
    is_main = 1,
    last_synced = unixepoch()
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (SELECT 1 FROM characters WHERE blizzard_char_id = 237938848);

DELETE FROM characters WHERE blizzard_char_id = 232758336;

-- death_analysis_events: PK is (report_code, fight_id, death_position), not
-- char id, so no collision is possible here.
UPDATE death_analysis_events
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336;

UPDATE death_analysis_stats
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM death_analysis_stats t
    WHERE t.report_code = death_analysis_stats.report_code AND t.blizzard_char_id = 237938848
  );
DELETE FROM death_analysis_stats WHERE blizzard_char_id = 232758336;

UPDATE raid_attendance_participants
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM raid_attendance_participants t
    WHERE t.report_id = raid_attendance_participants.report_id AND t.blizzard_char_id = 237938848
  );
DELETE FROM raid_attendance_participants WHERE blizzard_char_id = 232758336;

UPDATE raider_gear_cache
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM raider_gear_cache t
    WHERE t.slot_key = raider_gear_cache.slot_key AND t.blizzard_char_id = 237938848
  );
DELETE FROM raider_gear_cache WHERE blizzard_char_id = 232758336;

UPDATE raider_gear_slot_history
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM raider_gear_slot_history t
    WHERE t.slot_key = raider_gear_slot_history.slot_key
      AND t.item_id = raider_gear_slot_history.item_id
      AND t.blizzard_char_id = 237938848
  );
DELETE FROM raider_gear_slot_history WHERE blizzard_char_id = 232758336;

UPDATE raider_vault_history
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM raider_vault_history t
    WHERE t.week_start_ts = raider_vault_history.week_start_ts AND t.blizzard_char_id = 237938848
  );
DELETE FROM raider_vault_history WHERE blizzard_char_id = 232758336;

UPDATE raider_keystones
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (
    SELECT 1 FROM raider_keystones t
    WHERE t.completed_ts = raider_keystones.completed_ts AND t.blizzard_char_id = 237938848
  );
DELETE FROM raider_keystones WHERE blizzard_char_id = 232758336;

-- Single-row-per-character caches: the new id's row (if present) already
-- reflects the latest sync, so just drop the stale row rather than merge.
UPDATE raider_log_activity
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (SELECT 1 FROM raider_log_activity WHERE blizzard_char_id = 237938848);
DELETE FROM raider_log_activity WHERE blizzard_char_id = 232758336;

UPDATE bench_parses
SET blizzard_char_id = 237938848
WHERE blizzard_char_id = 232758336
  AND NOT EXISTS (SELECT 1 FROM bench_parses WHERE blizzard_char_id = 237938848);
DELETE FROM bench_parses WHERE blizzard_char_id = 232758336;
