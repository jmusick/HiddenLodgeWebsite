-- Hidden Lodge DB: raider preparedness 30-day history
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0023_preparedness_history.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0023_preparedness_history.sql

CREATE TABLE IF NOT EXISTS raider_preparedness_history (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_char_id        INTEGER NOT NULL,
    recorded_at             INTEGER NOT NULL,
    socketed_gems           INTEGER,
    total_sockets           INTEGER,
    enchanted_slots         INTEGER,
    enchantable_slots       INTEGER,
    FOREIGN KEY (blizzard_char_id) REFERENCES raider_metrics_cache(blizzard_char_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparedness_history_char_id ON raider_preparedness_history(blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_preparedness_history_recorded_at ON raider_preparedness_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_preparedness_history_char_recorded ON raider_preparedness_history(blizzard_char_id, recorded_at);

-- Add new columns to raider_metrics_cache for 30-day averages
ALTER TABLE raider_metrics_cache ADD COLUMN avg_30d_socketed_gems REAL;
ALTER TABLE raider_metrics_cache ADD COLUMN avg_30d_total_sockets REAL;
ALTER TABLE raider_metrics_cache ADD COLUMN avg_30d_enchanted_slots REAL;
ALTER TABLE raider_metrics_cache ADD COLUMN avg_30d_enchantable_slots REAL;
ALTER TABLE raider_metrics_cache ADD COLUMN preparedness_history_synced_at INTEGER;
