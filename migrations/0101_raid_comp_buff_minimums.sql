-- Officer-configured minimum providers for a per-target raid buff (currently
-- just Hunter's Mark), the same way raid_comp_utility_minimums already works
-- for utility items — a missing row falls back to the fixed default (1).
-- Run locally: npm run db:migrate:local -- migrations/0101_raid_comp_buff_minimums.sql

CREATE TABLE raid_comp_buff_minimums (
    buff_name           TEXT PRIMARY KEY,
    minimum_count       INTEGER NOT NULL DEFAULT 1,
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE raid_comp_loadouts ADD COLUMN buff_minimums_json TEXT NOT NULL DEFAULT '[]';
