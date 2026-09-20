-- Hidden Lodge DB: Raid Comp (Tools menu, guild members; officers edit).
-- Shared 20-man suggested raid comp built from Bench priority order. A single
-- settings row drives "Regenerate"; assignments are the actual group board,
-- editable one raider at a time via drag-and-drop.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0091_raid_comp.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0091_raid_comp.sql

-- Singleton row (id is always 1). Weight/scale mirror Bench's own combined-score
-- formula so "Regenerate" reproduces what an officer sees in Bench Order.
CREATE TABLE IF NOT EXISTS raid_comp_settings (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    tank_quota          INTEGER NOT NULL DEFAULT 2,
    healer_quota        INTEGER NOT NULL DEFAULT 5,
    dps_quota           INTEGER NOT NULL DEFAULT 13,
    weight              INTEGER NOT NULL DEFAULT 60,
    scale               TEXT    NOT NULL DEFAULT 'percentile' CHECK (scale IN ('percentile', 'raw')),
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One row per raider currently placed in a raid group; absence = benched.
CREATE TABLE IF NOT EXISTS raid_comp_assignments (
    blizzard_char_id    INTEGER PRIMARY KEY,
    raid_group          INTEGER NOT NULL CHECK (raid_group BETWEEN 1 AND 4),
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
