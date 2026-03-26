-- Hidden Lodge DB: change raider_notes to be keyed by user instead of character
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0035_raider_notes_by_user.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0035_raider_notes_by_user.sql

DROP TABLE IF EXISTS raider_notes;

CREATE TABLE IF NOT EXISTS raider_notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_text      TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_raider_notes_user   ON raider_notes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raider_notes_author ON raider_notes(author_user_id);
