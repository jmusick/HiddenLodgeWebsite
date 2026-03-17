CREATE TABLE IF NOT EXISTS roster_members_cache (
    blizzard_char_id   INTEGER PRIMARY KEY,
    name               TEXT    NOT NULL,
    realm              TEXT    NOT NULL,
    realm_slug         TEXT    NOT NULL,
    class_name         TEXT    NOT NULL,
    race_name          TEXT    NOT NULL,
    level              INTEGER NOT NULL DEFAULT 0,
    rank               INTEGER NOT NULL DEFAULT 0,
    achievement_points INTEGER NOT NULL DEFAULT 0,
    mount_count        INTEGER NOT NULL DEFAULT 0,
    pet_count          INTEGER NOT NULL DEFAULT 0,
    toy_count          INTEGER NOT NULL DEFAULT 0,
    details_synced_at  INTEGER,
    summary_synced_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_roster_members_rank_name ON roster_members_cache(rank, name);
CREATE INDEX IF NOT EXISTS idx_roster_members_details_synced_at ON roster_members_cache(details_synced_at);

CREATE TABLE IF NOT EXISTS roster_cache_meta (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    guild_name_slug      TEXT    NOT NULL,
    guild_realm_slug     TEXT    NOT NULL,
    last_summary_sync    INTEGER,
    last_detail_sync     INTEGER,
    pending_detail_count INTEGER NOT NULL DEFAULT 0,
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO roster_cache_meta (
    id,
    guild_name_slug,
    guild_realm_slug,
    pending_detail_count,
    updated_at
) VALUES (1, 'hidden-lodge', 'illidan', 0, unixepoch());
