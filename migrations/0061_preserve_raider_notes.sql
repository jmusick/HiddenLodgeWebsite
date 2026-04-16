-- Hidden Lodge DB: preserve raider notes if roster cache entries are pruned
-- Raider notes should survive temporary roster absences and later reappear when the character returns.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0061_preserve_raider_notes.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0061_preserve_raider_notes.sql

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS raider_notes_new;

CREATE TABLE raider_notes_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    blizzard_char_id INTEGER NOT NULL,
    author_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_text        TEXT    NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO raider_notes_new (id, blizzard_char_id, author_user_id, note_text, created_at)
SELECT id, blizzard_char_id, author_user_id, note_text, created_at
FROM raider_notes;

DROP TABLE raider_notes;
ALTER TABLE raider_notes_new RENAME TO raider_notes;

CREATE INDEX IF NOT EXISTS idx_raider_notes_char ON raider_notes(blizzard_char_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raider_notes_author ON raider_notes(author_user_id);

PRAGMA foreign_keys = ON;