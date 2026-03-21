-- Hidden Lodge DB: raiders cache
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0013_raiders_cache.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0013_raiders_cache.sql

CREATE TABLE IF NOT EXISTS raider_metrics_cache (
    blizzard_char_id        INTEGER PRIMARY KEY,
    name                    TEXT    NOT NULL,
    realm                   TEXT    NOT NULL,
    realm_slug              TEXT    NOT NULL,
    class_name              TEXT    NOT NULL,
    team_names              TEXT    NOT NULL DEFAULT '',
    auth_state              TEXT    NOT NULL DEFAULT 'missing' CHECK (auth_state IN ('ready', 'missing', 'expired', 'unavailable')),
    equipped_item_level     INTEGER,
    average_item_level      INTEGER,
    mythic_score            REAL,
    tier_pieces_equipped    INTEGER,
    socketed_gems           INTEGER,
    total_sockets           INTEGER,
    enchanted_slots         INTEGER,
    enchantable_slots       INTEGER,
    adventurer_crests       INTEGER,
    veteran_crests          INTEGER,
    champion_crests         INTEGER,
    hero_crests             INTEGER,
    myth_crests             INTEGER,
    total_upgrades_missing  INTEGER,
    source_token_expires_at INTEGER,
    details_synced_at       INTEGER,
    summary_synced_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raider_metrics_auth_state ON raider_metrics_cache(auth_state);
CREATE INDEX IF NOT EXISTS idx_raider_metrics_details_synced_at ON raider_metrics_cache(details_synced_at);