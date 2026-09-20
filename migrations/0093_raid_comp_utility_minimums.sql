-- Hidden Lodge DB: officer-configured minimum count per raid utility item
-- (e.g. "need 2 Demonic Gateways this fight"), used by Raid Comp's
-- "Regenerate" to force in extra providers the same way raid buffs already
-- get at least one. A missing row means no requirement (0).
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0093_raid_comp_utility_minimums.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0093_raid_comp_utility_minimums.sql

CREATE TABLE IF NOT EXISTS raid_comp_utility_minimums (
    utility_name        TEXT PRIMARY KEY,
    minimum_count       INTEGER NOT NULL DEFAULT 0,
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
