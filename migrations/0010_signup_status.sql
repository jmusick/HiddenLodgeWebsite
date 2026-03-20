-- Hidden Lodge DB: raid signup attendance status
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0010_signup_status.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0010_signup_status.sql

ALTER TABLE raid_signups ADD COLUMN signup_status TEXT NOT NULL DEFAULT 'coming' CHECK (signup_status IN ('coming', 'tentative'));

UPDATE raid_signups
SET signup_status = 'coming'
WHERE signup_status IS NULL OR signup_status = '';

CREATE INDEX IF NOT EXISTS idx_raid_signups_status
ON raid_signups(user_id, signup_status, created_at);
