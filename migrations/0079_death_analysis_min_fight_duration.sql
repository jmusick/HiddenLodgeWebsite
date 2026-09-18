-- Hidden Lodge DB: no schema change. Death Analysis now excludes fights under
-- 30 seconds (usually an immediate wipe, not a real attempt) from pulls,
-- kills, death stats, and death events. Force every tracked report to be
-- re-pulled so already-synced nights get rescored under the new rule.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0079_death_analysis_min_fight_duration.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0079_death_analysis_min_fight_duration.sql

UPDATE death_analysis_reports SET synced_at = 0;
