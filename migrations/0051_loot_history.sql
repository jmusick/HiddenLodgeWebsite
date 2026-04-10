CREATE TABLE IF NOT EXISTS loot_history (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_key            TEXT    NOT NULL UNIQUE,
    source_id            TEXT    NOT NULL,
    faction_realm        TEXT,
    owner_full_name      TEXT    NOT NULL,
    owner_name           TEXT    NOT NULL,
    owner_realm          TEXT,
    owner_blizzard_char_id INTEGER REFERENCES characters(blizzard_char_id),
    class_name           TEXT,
    map_id               INTEGER,
    difficulty_id        INTEGER,
    instance_name        TEXT,
    boss_name            TEXT,
    group_size           INTEGER,
    awarded_date         TEXT,
    awarded_time         TEXT,
    awarded_at_epoch     INTEGER,
    response_text        TEXT,
    response_id          TEXT,
    type_code            TEXT,
    note_text            TEXT,
    loot_won_link        TEXT    NOT NULL,
    item_id              INTEGER,
    item_name            TEXT,
    item_class_id        INTEGER,
    item_sub_class_id    INTEGER,
    is_award_reason      INTEGER NOT NULL DEFAULT 0,
    synced_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_loot_history_owner ON loot_history(owner_name, owner_realm);
CREATE INDEX IF NOT EXISTS idx_loot_history_awarded_at ON loot_history(awarded_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_loot_history_item_id ON loot_history(item_id);
