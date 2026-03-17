-- Hidden Lodge DB: initial schema
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0001_initial.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0001_initial.sql

CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_id      INTEGER NOT NULL UNIQUE,
    battle_tag       TEXT    NOT NULL,
    access_token     TEXT,
    token_expires_at INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS characters (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blizzard_char_id INTEGER NOT NULL,
    name             TEXT    NOT NULL,
    realm            TEXT    NOT NULL,
    realm_slug       TEXT    NOT NULL,
    class_name       TEXT    NOT NULL,
    race_name        TEXT    NOT NULL,
    faction          TEXT    NOT NULL,
    level            INTEGER NOT NULL DEFAULT 0,
    avatar_url       TEXT,
    is_main          INTEGER NOT NULL DEFAULT 0,
    last_synced      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, blizzard_char_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);
