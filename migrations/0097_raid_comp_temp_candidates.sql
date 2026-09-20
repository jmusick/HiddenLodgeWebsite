-- Hidden Lodge DB: officer-managed temporary Raid Comp candidates for PUGs and trials.
-- Run locally:  npm run db:migrate:local -- migrations/0097_raid_comp_temp_candidates.sql
-- Run in prod:  npm run db:migrate:prod -- migrations/0097_raid_comp_temp_candidates.sql

CREATE TABLE raid_comp_temp_candidates (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    class_name          TEXT NOT NULL,
    assigned_role       TEXT NOT NULL CHECK (assigned_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps')),
    created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
