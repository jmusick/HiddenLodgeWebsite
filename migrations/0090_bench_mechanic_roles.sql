-- Hidden Lodge DB: per-character melee/ranged (and tank/healer) role cache,
-- derived from Warcraft Logs CombatantInfo (spec) on the latest canonical raid
-- night. Powers Raid Comp, which needs melee/ranged for DPS beyond Bench's
-- own tank/healer/dps split.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0090_bench_mechanic_roles.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0090_bench_mechanic_roles.sql

-- One row per character, overwritten whenever a newer canonical report is
-- synced. A character absent from the latest report (benched that night)
-- simply keeps its last known role rather than being cleared.
CREATE TABLE IF NOT EXISTS bench_mechanic_roles (
    blizzard_char_id     INTEGER PRIMARY KEY,
    spec_id              INTEGER NOT NULL,
    mechanic_role        TEXT CHECK (mechanic_role IN ('tank', 'healer', 'melee', 'ranged') OR mechanic_role IS NULL),
    source_report_code   TEXT    NOT NULL,
    synced_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
