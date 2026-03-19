-- Hidden Lodge DB: split generic DPS into melee and ranged roles
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0007_split_dps_roles.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0007_split_dps_roles.sql

ALTER TABLE raid_team_members RENAME TO raid_team_members_old;

CREATE TABLE raid_team_members (
    team_id          INTEGER NOT NULL REFERENCES raid_teams(id) ON DELETE CASCADE,
    blizzard_char_id INTEGER NOT NULL REFERENCES roster_members_cache(blizzard_char_id) ON DELETE CASCADE,
    assigned_role    TEXT    NOT NULL CHECK (assigned_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps')),
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (team_id, blizzard_char_id)
);

INSERT INTO raid_team_members (team_id, blizzard_char_id, assigned_role, created_at, updated_at)
SELECT
    team_id,
    blizzard_char_id,
    CASE assigned_role
        WHEN 'dps' THEN 'ranged-dps'
        ELSE assigned_role
    END,
    created_at,
    updated_at
FROM raid_team_members_old;

DROP TABLE raid_team_members_old;

CREATE INDEX IF NOT EXISTS idx_raid_team_members_team ON raid_team_members(team_id, assigned_role);
CREATE INDEX IF NOT EXISTS idx_raid_team_members_char ON raid_team_members(blizzard_char_id);