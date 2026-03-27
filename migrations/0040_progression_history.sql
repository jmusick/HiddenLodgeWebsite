-- Hidden Lodge DB: raider progression history (ilvl, M+ score, crests, missing upgrades)
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0040_progression_history.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0040_progression_history.sql

CREATE TABLE IF NOT EXISTS raider_progression_history (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_char_id        INTEGER NOT NULL,
    recorded_at             INTEGER NOT NULL,
    equipped_item_level     INTEGER,
    mythic_score            REAL,
    adventurer_crests       INTEGER,
    veteran_crests          INTEGER,
    champion_crests         INTEGER,
    hero_crests             INTEGER,
    myth_crests             INTEGER,
    total_upgrades_missing  INTEGER,
    FOREIGN KEY (blizzard_char_id) REFERENCES raider_metrics_cache(blizzard_char_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progression_history_char_id ON raider_progression_history(blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_progression_history_recorded_at ON raider_progression_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_progression_history_char_recorded ON raider_progression_history(blizzard_char_id, recorded_at);
