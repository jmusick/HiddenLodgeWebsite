PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS loot_history_new (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_key              TEXT    NOT NULL UNIQUE,
    source_id              TEXT    NOT NULL,
    faction_realm          TEXT,
    owner_full_name        TEXT    NOT NULL,
    owner_name             TEXT    NOT NULL,
    owner_realm            TEXT,
    owner_blizzard_char_id INTEGER,
    class_name             TEXT,
    map_id                 INTEGER,
    difficulty_id          INTEGER,
    instance_name          TEXT,
    boss_name              TEXT,
    group_size             INTEGER,
    awarded_date           TEXT,
    awarded_time           TEXT,
    awarded_at_epoch       INTEGER,
    response_text          TEXT,
    response_id            TEXT,
    type_code              TEXT,
    note_text              TEXT,
    loot_won_link          TEXT    NOT NULL,
    item_id                INTEGER,
    item_name              TEXT,
    item_class_id          INTEGER,
    item_sub_class_id      INTEGER,
    is_award_reason        INTEGER NOT NULL DEFAULT 0,
    synced_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO loot_history_new (
    id,
    entry_key,
    source_id,
    faction_realm,
    owner_full_name,
    owner_name,
    owner_realm,
    owner_blizzard_char_id,
    class_name,
    map_id,
    difficulty_id,
    instance_name,
    boss_name,
    group_size,
    awarded_date,
    awarded_time,
    awarded_at_epoch,
    response_text,
    response_id,
    type_code,
    note_text,
    loot_won_link,
    item_id,
    item_name,
    item_class_id,
    item_sub_class_id,
    is_award_reason,
    synced_at
)
SELECT
    id,
    entry_key,
    source_id,
    faction_realm,
    owner_full_name,
    owner_name,
    owner_realm,
    owner_blizzard_char_id,
    class_name,
    map_id,
    difficulty_id,
    instance_name,
    boss_name,
    group_size,
    awarded_date,
    awarded_time,
    awarded_at_epoch,
    response_text,
    response_id,
    type_code,
    note_text,
    loot_won_link,
    item_id,
    item_name,
    item_class_id,
    item_sub_class_id,
    is_award_reason,
    synced_at
FROM loot_history;

DROP TABLE loot_history;
ALTER TABLE loot_history_new RENAME TO loot_history;

CREATE INDEX IF NOT EXISTS idx_loot_history_owner ON loot_history(owner_name, owner_realm);
CREATE INDEX IF NOT EXISTS idx_loot_history_awarded_at ON loot_history(awarded_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_loot_history_item_id ON loot_history(item_id);

PRAGMA foreign_keys = ON;