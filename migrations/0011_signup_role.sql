-- Hidden Lodge DB: add role selection to raid signups
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0011_signup_role.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0011_signup_role.sql

ALTER TABLE raid_signups ADD COLUMN signup_role TEXT NOT NULL DEFAULT 'ranged-dps' CHECK (signup_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps'));

UPDATE raid_signups
SET signup_role = 'ranged-dps'
WHERE signup_role IS NULL OR signup_role = '';

CREATE INDEX IF NOT EXISTS idx_raid_signups_role
ON raid_signups(user_id, signup_role, created_at);
