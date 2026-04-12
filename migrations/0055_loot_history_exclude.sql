-- Add exclusion support to loot_history
-- Officers can mark an entry as excluded (with a required note) to remove it from history.
ALTER TABLE loot_history ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loot_history ADD COLUMN exclude_note TEXT;
ALTER TABLE loot_history ADD COLUMN excluded_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE loot_history ADD COLUMN excluded_at INTEGER;
