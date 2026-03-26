-- Hidden Lodge DB: revert raider_notes to blizzard_char_id for pre-auth note support
-- Notes are keyed by character so they persist before a player logs in.
-- When displaying for an authed user, we aggregate across all their characters.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0036_raider_notes_by_char.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0036_raider_notes_by_char.sql

DROP TABLE IF EXISTS raider_notes;

CREATE TABLE IF NOT EXISTS raider_notes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_char_id INTEGER NOT NULL REFERENCES roster_members_cache(blizzard_char_id) ON DELETE CASCADE,
    author_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_text        TEXT    NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raider_notes_char   ON raider_notes(blizzard_char_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raider_notes_author ON raider_notes(author_user_id);
