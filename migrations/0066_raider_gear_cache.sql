-- Per-slot equipped-gear cache, populated by the raider details refresh cron
-- (reuses the /equipment payload already fetched in enrichRaider -- no extra
-- Blizzard API calls). Starts empty; backfills gradually as each level-90
-- raider's details TTL rolls over (see DETAILS_TTL_SECONDS in raiders.ts).

CREATE TABLE IF NOT EXISTS raider_gear_cache (
    blizzard_char_id  INTEGER NOT NULL,
    slot_key          TEXT    NOT NULL,
    item_id           INTEGER,
    item_name         TEXT,
    item_level        INTEGER,
    quality           TEXT,
    quality_color     TEXT    NOT NULL DEFAULT '#90a4b2',
    enchantments_json TEXT    NOT NULL DEFAULT '[]',
    gems_json         TEXT    NOT NULL DEFAULT '[]',
    sockets_filled    INTEGER NOT NULL DEFAULT 0,
    sockets_total     INTEGER NOT NULL DEFAULT 0,
    can_enchant       INTEGER NOT NULL DEFAULT 0,
    can_gem           INTEGER NOT NULL DEFAULT 0,
    synced_at         INTEGER NOT NULL,
    PRIMARY KEY (blizzard_char_id, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_raider_gear_cache_synced_at ON raider_gear_cache(synced_at);
