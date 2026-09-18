-- Hidden Lodge DB: spell/ability icon cache, mirroring item_icon_cache
-- (migrations/0062_item_icon_cache.sql) but for Blizzard's spell media
-- endpoint. Used by the Death Analysis defensive-cooldown estimate to show
-- an icon per ability instead of plain text.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0081_spell_icon_cache.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0081_spell_icon_cache.sql

CREATE TABLE IF NOT EXISTS spell_icon_cache (
  spell_id   INTEGER PRIMARY KEY,
  icon_url   TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
