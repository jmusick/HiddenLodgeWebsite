-- Hidden Lodge DB: Bench analysis (Admin > Bench, officers). Combines Death
-- Analysis with each raider's median Warcraft Logs parse to suggest who to bench.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0077_bench_analysis.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0077_bench_analysis.sql

-- Cached WCL zoneRankings per character, one median per role so an officer's
-- role override takes effect without refetching. NULL median = no ranked kills
-- in that role. wcl_found = 0 when WCL has no character by that name/realm.
CREATE TABLE IF NOT EXISTS bench_parses (
    blizzard_char_id  INTEGER PRIMARY KEY,
    zone_id           INTEGER NOT NULL,
    difficulty        INTEGER NOT NULL,
    wcl_found         INTEGER NOT NULL DEFAULT 0,
    dps_median        REAL,
    dps_bosses        INTEGER NOT NULL DEFAULT 0,
    healer_median     REAL,
    healer_bosses     INTEGER NOT NULL DEFAULT 0,
    tank_median       REAL,
    tank_bosses       INTEGER NOT NULL DEFAULT 0,
    synced_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Officer-chosen role when the automatic pick (role with the most ranked
-- bosses) is wrong, e.g. a flex healer/DPS.
CREATE TABLE IF NOT EXISTS bench_role_overrides (
    blizzard_char_id    INTEGER PRIMARY KEY,
    role                TEXT    NOT NULL CHECK (role IN ('dps', 'healer', 'tank')),
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
