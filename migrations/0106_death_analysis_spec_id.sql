-- Death Analysis spec adjustment: record the spec each raider played most in
-- a report's scored pulls, so their death score can be compared against that
-- spec's worldwide death rate (src/lib/spec-death-rates.ts). Rows synced
-- before this column existed stay NULL and fall back to the raider's latest
-- spec in bench_mechanic_roles; they age out of the rolling window on their own.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0106_death_analysis_spec_id.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0106_death_analysis_spec_id.sql

ALTER TABLE death_analysis_stats ADD COLUMN spec_id INTEGER;
