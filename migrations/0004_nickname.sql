-- Hidden Lodge DB: add nickname to users, remove manual profile tables
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0004_nickname.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0004_nickname.sql

ALTER TABLE users ADD COLUMN nickname TEXT;

-- Remove the manual profile grouping tables introduced in 0003 (no longer needed)
DROP TABLE IF EXISTS member_profile_characters;
DROP TABLE IF EXISTS member_profiles;
