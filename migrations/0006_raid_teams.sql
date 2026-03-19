-- Hidden Lodge DB: raid roster teams
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0006_raid_teams.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0006_raid_teams.sql

CREATE TABLE IF NOT EXISTS raid_teams (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    raid_mode  TEXT    NOT NULL DEFAULT 'mythic' CHECK (raid_mode IN ('flex', 'mythic')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS raid_team_members (
    team_id          INTEGER NOT NULL REFERENCES raid_teams(id) ON DELETE CASCADE,
    blizzard_char_id INTEGER NOT NULL REFERENCES roster_members_cache(blizzard_char_id) ON DELETE CASCADE,
    assigned_role    TEXT    NOT NULL CHECK (assigned_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps')),
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (team_id, blizzard_char_id)
);

CREATE INDEX IF NOT EXISTS idx_raid_teams_sort ON raid_teams(sort_order, name);
CREATE INDEX IF NOT EXISTS idx_raid_team_members_team ON raid_team_members(team_id, assigned_role);
CREATE INDEX IF NOT EXISTS idx_raid_team_members_char ON raid_team_members(blizzard_char_id);
