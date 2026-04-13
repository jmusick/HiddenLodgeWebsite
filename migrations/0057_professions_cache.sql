CREATE TABLE IF NOT EXISTS profession_recipe_owners_cache (
    blizzard_char_id INTEGER NOT NULL,
    character_name   TEXT    NOT NULL,
    realm_slug       TEXT    NOT NULL,
    profession_id    INTEGER NOT NULL,
    profession_name  TEXT    NOT NULL,
    recipe_id        INTEGER NOT NULL,
    recipe_name      TEXT    NOT NULL,
    synced_at        INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (blizzard_char_id, recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_prof_recipe_profession ON profession_recipe_owners_cache(profession_id, recipe_name);
CREATE INDEX IF NOT EXISTS idx_prof_recipe_recipe ON profession_recipe_owners_cache(recipe_id, profession_id);
CREATE INDEX IF NOT EXISTS idx_prof_recipe_char ON profession_recipe_owners_cache(blizzard_char_id);

CREATE TABLE IF NOT EXISTS profession_character_sync_cache (
    blizzard_char_id   INTEGER PRIMARY KEY,
    character_name     TEXT    NOT NULL,
    realm_slug         TEXT    NOT NULL,
    profession_count   INTEGER NOT NULL DEFAULT 0,
    recipe_count       INTEGER NOT NULL DEFAULT 0,
    last_status        TEXT    NOT NULL DEFAULT 'unknown',
    last_error         TEXT,
    last_synced_at     INTEGER,
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_prof_char_sync_last_synced ON profession_character_sync_cache(last_synced_at);
