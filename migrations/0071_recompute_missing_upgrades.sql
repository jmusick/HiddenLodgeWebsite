-- Missing-upgrade totals were computed against a bonus-id table that only knew
-- Midnight Season 1's upgrade tracks (12769-12806), so every Season 2 item
-- (12809-12846) looked fully upgraded and raiders collapsed to 0 missing
-- upgrades. src/lib/raiders.ts now knows both blocks; recompute the cached
-- totals from the bonus ids already stored in raider_gear_cache so the numbers
-- correct themselves immediately instead of waiting out each raider's 12h
-- details TTL.
--
-- Mirrors computeTotalUpgradesMissing(): tracks are 6 consecutive step ids,
-- 8 ids apart, so a step's remaining upgrades = 5 - ((id - seasonBase) % 8).
UPDATE raider_metrics_cache
   SET total_upgrades_missing = COALESCE((
         SELECT SUM(5 - ((j.value - (CASE WHEN j.value < 12809 THEN 12769 ELSE 12809 END)) % 8))
           FROM raider_gear_cache g, json_each(g.bonus_list_json) j
          WHERE g.blizzard_char_id = raider_metrics_cache.blizzard_char_id
            AND j.value BETWEEN 12769 AND 12846
            AND ((j.value - (CASE WHEN j.value < 12809 THEN 12769 ELSE 12809 END)) % 8) <= 5
       ), 0)
 WHERE EXISTS (
         SELECT 1 FROM raider_gear_cache g
          WHERE g.blizzard_char_id = raider_metrics_cache.blizzard_char_id
       );
