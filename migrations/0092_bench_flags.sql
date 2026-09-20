-- Hidden Lodge DB: officer-set per-character flags for Bench/Raid Comp.
-- Separate from bench_role_overrides (tank/healer/dps) since these are a
-- different axis: melee-vs-ranged correction, and participation flags that
-- gate Raid Comp's "Regenerate" (absent = never picked, raid leader = always
-- picked). A row only exists once an officer sets at least one of these.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0092_bench_flags.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0092_bench_flags.sql

CREATE TABLE IF NOT EXISTS bench_flags (
    blizzard_char_id    INTEGER PRIMARY KEY,
    melee_ranged        TEXT CHECK (melee_ranged IN ('melee', 'ranged') OR melee_ranged IS NULL),
    is_absent           INTEGER NOT NULL DEFAULT 0,
    is_raid_leader      INTEGER NOT NULL DEFAULT 0,
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
