-- Marks roster placements changed by an officer after automatic Regenerate.
-- Run locally: npm run db:migrate:local -- migrations/0100_raid_comp_manual_overrides.sql

CREATE TABLE raid_comp_manual_overrides (
    blizzard_char_id   INTEGER PRIMARY KEY,
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Save the manual-placement marker for both assigned and benched raiders in a named loadout.
ALTER TABLE raid_comp_loadouts ADD COLUMN manual_override_ids_json TEXT NOT NULL DEFAULT '[]';
