-- Hidden Lodge DB: per-character Mythic+ keystone run log (WoWAudit-style accumulation)
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0044_raider_keystones.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0044_raider_keystones.sql

-- Stores every unique keystone run timestamp observed for a character.
-- Each refresh merges newly-seen runs in; we never delete rows for the current season.
-- Weekly count   = COUNT(*) WHERE blizzard_char_id = ? AND completed_ts >= weekly_reset_ts
-- Season count   = COUNT(*) WHERE blizzard_char_id = ? AND completed_ts >= season_start_ts
-- Great Vault    = top-N key levels sorted DESC from current week rows
CREATE TABLE IF NOT EXISTS raider_keystones (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  blizzard_char_id   INTEGER NOT NULL,
  completed_ts       INTEGER NOT NULL,   -- unix seconds (from completed_at_timestamp or parsed completed_at)
  dungeon_id         INTEGER,            -- map_challenge_mode_id
  keystone_level     INTEGER,            -- mythic_level / keystone_level
  UNIQUE(blizzard_char_id, completed_ts)
);

CREATE INDEX IF NOT EXISTS idx_raider_keystones_char_ts
  ON raider_keystones(blizzard_char_id, completed_ts DESC);
