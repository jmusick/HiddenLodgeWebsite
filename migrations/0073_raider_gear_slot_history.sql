-- Hidden Lodge DB: per-slot equipped-item history, 60-day retention.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0073_raider_gear_slot_history.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0073_raider_gear_slot_history.sql

-- One row per distinct item ever seen in a given raider's slot. Re-observing
-- the same item just bumps last_seen_at; a genuinely different item gets its
-- own row. Rows age out 60 days after they were last seen (see
-- GEAR_HISTORY_WINDOW_SECONDS / pruneGearSlotHistory in raiders.ts).
CREATE TABLE IF NOT EXISTS raider_gear_slot_history (
    blizzard_char_id  INTEGER NOT NULL,
    slot_key          TEXT    NOT NULL,
    item_id           INTEGER NOT NULL,
    item_name         TEXT,
    item_level        INTEGER,
    quality           TEXT,
    quality_color     TEXT    NOT NULL DEFAULT '#90a4b2',
    bonus_list_json   TEXT    NOT NULL DEFAULT '[]',
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    PRIMARY KEY (blizzard_char_id, slot_key, item_id)
);

CREATE INDEX IF NOT EXISTS idx_gear_slot_history_last_seen ON raider_gear_slot_history(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_gear_slot_history_char_slot ON raider_gear_slot_history(blizzard_char_id, slot_key);
