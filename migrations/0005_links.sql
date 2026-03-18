-- Hidden Lodge DB: links tables
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0005_links.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0005_links.sql

CREATE TABLE IF NOT EXISTS link_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    icon       TEXT    NOT NULL DEFAULT 'lucide:link',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES link_categories(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    href        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_links_category_id ON links(category_id);
CREATE INDEX IF NOT EXISTS idx_link_categories_sort ON link_categories(sort_order);
CREATE INDEX IF NOT EXISTS idx_links_sort ON links(category_id, sort_order);

-- Seed from existing hardcoded data
INSERT INTO link_categories (id, title, icon, sort_order) VALUES
    (1, 'General Guides',                    'lucide:book-open-text',    10),
    (2, 'Simming/Gearing',                   'lucide:anvil',             20),
    (3, 'Talent Specs/Meta (Log data driven)','lucide:line-chart',        30),
    (4, 'Raiding',                            'lucide:swords',            40),
    (5, 'Mythic+',                            'lucide:shield-plus',       50),
    (6, 'Logs and Analysis',                  'lucide:scroll-text',       60),
    (7, 'UI',                                 'lucide:layout-dashboard',  70),
    (8, 'Misc Stuff',                         'lucide:sparkles',          80);

INSERT INTO links (category_id, name, href, sort_order) VALUES
    -- General Guides
    (1, 'Icy Veins',      'https://www.icy-veins.com/wow/class-guides',   10),
    (1, 'Wowhead',        'https://www.wowhead.com/guides/classes',        20),
    (1, 'Class Discords', 'https://www.wowhead.com/discord-servers',       30),
    -- Simming/Gearing
    (2, 'Raidbots',                'https://www.raidbots.com/',                    10),
    (2, 'QE Live (Healer Sims)',   'https://questionablyepic.com/live/',           20),
    (2, 'Bloodmallet',             'https://bloodmallet.com/',                     30),
    -- Talent Specs/Meta
    (3, 'Archon.gg',    'https://www.archon.gg/',    10),
    (3, 'Murlok.io',    'https://murlok.io/',         20),
    (3, 'U.gg',         'https://u.gg/wow',           30),
    (3, 'Wowmeta.com',  'https://wowmeta.com/',       40),
    -- Raiding
    (4, 'Mythic Trap (Boss Strats)', 'https://www.mythictrap.com/en',                      10),
    (4, 'Lorrgs (CD timing)',        'https://lorrgs.io/',                                  20),
    (4, 'wowaudit',                  'https://wowaudit.com/us/illidan/hidden-lodge',        30),
    (4, 'Viserio CDs',               'https://wowutils.com/viserio-cooldowns',              40),
    (4, 'Raidplan',                  'https://raidplan.io/',                                50),
    -- Mythic+
    (5, 'MythicStats (Meta and spec performance)', 'https://mythicstats.com/', 10),
    (5, 'Raider.io',                               'https://raider.io/',        20),
    (5, 'Skyfury (Fun M+ stats and group finding)', 'https://skyfury.co/',      30),
    -- Logs and Analysis
    (6, 'WarcraftLogs',                  'https://www.warcraftlogs.com/', 10),
    (6, 'Wipefest.gg (Mechanics analysis)', 'https://www.wipefest.gg/',    20),
    (6, 'WoWAnalyzer (Spec analysis)',    'https://wowanalyzer.com/',      30),
    -- UI
    (7, 'Wago.io',                       'https://wago.io/',             10),
    (7, 'Wago App (Keep WAs up to date)', 'https://addons.wago.io/app',  20),
    -- Misc Stuff
    (8, 'Simple Armory (Good mount farming routing)', 'https://simplearmory.com/', 10),
    (8, 'WowAlts.io',                               'https://www.wowalts.io/',    20);
