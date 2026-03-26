-- Hidden Lodge DB: raider officer notes
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0034_raider_notes.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0034_raider_notes.sql

CREATE TABLE IF NOT EXISTS raider_notes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_char_id INTEGER NOT NULL REFERENCES roster_members_cache(blizzard_char_id) ON DELETE CASCADE,
    author_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_text        TEXT    NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raider_notes_char ON raider_notes(blizzard_char_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raider_notes_author ON raider_notes(author_user_id);
