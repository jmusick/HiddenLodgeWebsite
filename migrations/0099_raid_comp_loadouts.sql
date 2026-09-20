-- Named Raid Comp snapshots: exact board placements plus generation settings and utility minimums.
-- Run locally: npm run db:migrate:local -- migrations/0099_raid_comp_loadouts.sql

CREATE TABLE raid_comp_loadouts (
    id                    INTEGER PRIMARY KEY,
    name                  TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
    settings_json         TEXT NOT NULL,
    utility_minimums_json TEXT NOT NULL,
    created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE raid_comp_loadout_assignments (
    loadout_id        INTEGER NOT NULL REFERENCES raid_comp_loadouts(id) ON DELETE CASCADE,
    blizzard_char_id  INTEGER NOT NULL,
    raid_group        INTEGER NOT NULL CHECK (raid_group >= 1),
    PRIMARY KEY (loadout_id, blizzard_char_id)
);
