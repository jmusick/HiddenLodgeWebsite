-- Hidden Lodge DB: add preferred raid role to users
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0026_preferred_role.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0026_preferred_role.sql

ALTER TABLE users ADD COLUMN preferred_role TEXT CHECK (preferred_role IN ('tank', 'healer', 'melee-dps', 'ranged-dps'));
