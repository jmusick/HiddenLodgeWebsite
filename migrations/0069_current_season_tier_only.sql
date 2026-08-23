-- Only Midnight Season 2 (patch 12.1) class sets count as tier now; Season 1
-- (12.0) pieces give no set bonus, so they must stop showing the tier badge.
-- Blizzard hands out each season's 13 class sets as one contiguous item-id
-- block (9 ids per class), so the season is an item-id range. Keep this in sync
-- with CURRENT_TIER_SET_ITEM_ID_MIN/MAX in src/lib/raiders.ts.
-- Cached rows would otherwise keep the stale flag until each raider re-syncs.
UPDATE raider_gear_cache
   SET is_tier_set = CASE
     WHEN slot_key IN ('HEAD', 'SHOULDER', 'CHEST', 'HANDS', 'LEGS')
      AND item_id BETWEEN 271454 AND 271570
     THEN 1 ELSE 0
   END;
