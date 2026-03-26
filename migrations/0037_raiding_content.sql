-- Raiding page: editable content panels
-- Run locally: npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0037_raiding_content.sql
-- Run in prod: npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0037_raiding_content.sql

-- Key/value store for rich-text sections (schedule, raid_expectations, recruitment)
CREATE TABLE IF NOT EXISTS raiding_content (
    key        TEXT PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Required addons list
CREATE TABLE IF NOT EXISTS raiding_addons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO raiding_addons (id, name, url, sort_order) VALUES
    (1, 'Deadly Boss Mods',       'https://www.curseforge.com/wow/addons/deadly-boss-mods',          10),
    (2, 'Method Raid Tools',      'https://www.curseforge.com/wow/addons/method-raid-tools',         20),
    (3, 'Northern Sky Raid Tools','https://www.curseforge.com/wow/addons/northern-sky-raid-tools',   30),
    (4, 'RCLootCouncil',          'https://www.curseforge.com/wow/addons/rclootcouncil',             40);

-- Current recruitment needs list
CREATE TABLE IF NOT EXISTS recruitment_needs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class      TEXT NOT NULL,
    role       TEXT NOT NULL,
    priority   TEXT NOT NULL DEFAULT 'mid' CHECK (priority IN ('low', 'mid', 'high')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
