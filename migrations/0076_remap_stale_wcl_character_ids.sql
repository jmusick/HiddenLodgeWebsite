-- Hidden Lodge DB: move Death Analysis stats off stale character ids.
-- WCL actors used to be matched by name + realm only, so where `characters`
-- held an old deleted character with the same name + realm, its id won. Matching
-- now uses the WCL actor's gameID (the Blizzard character id), confirmed against
-- report 1BMkxhDgvX2pNzWy:
--   Wispi-Area 52       247746639 (stale Druid)        -> 247390553 (Paladin)
--   Bophadease-Illidan  224910813 (stale Demon Hunter) -> 237889337
-- Idempotent; skips any row whose target (report, character) already exists.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0076_remap_stale_wcl_character_ids.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0076_remap_stale_wcl_character_ids.sql

UPDATE death_analysis_stats
SET blizzard_char_id = 247390553
WHERE blizzard_char_id = 247746639
  AND NOT EXISTS (
    SELECT 1 FROM death_analysis_stats t
    WHERE t.report_code = death_analysis_stats.report_code AND t.blizzard_char_id = 247390553
  );

UPDATE death_analysis_stats
SET blizzard_char_id = 237889337
WHERE blizzard_char_id = 224910813
  AND NOT EXISTS (
    SELECT 1 FROM death_analysis_stats t
    WHERE t.report_code = death_analysis_stats.report_code AND t.blizzard_char_id = 237889337
  );

UPDATE mechanics_analysis_stats
SET blizzard_char_id = 247390553
WHERE blizzard_char_id = 247746639
  AND NOT EXISTS (
    SELECT 1 FROM mechanics_analysis_stats t
    WHERE t.report_code = mechanics_analysis_stats.report_code
      AND t.mechanic_key = mechanics_analysis_stats.mechanic_key
      AND t.blizzard_char_id = 247390553
  );

UPDATE mechanics_analysis_stats
SET blizzard_char_id = 237889337
WHERE blizzard_char_id = 224910813
  AND NOT EXISTS (
    SELECT 1 FROM mechanics_analysis_stats t
    WHERE t.report_code = mechanics_analysis_stats.report_code
      AND t.mechanic_key = mechanics_analysis_stats.mechanic_key
      AND t.blizzard_char_id = 237889337
  );
