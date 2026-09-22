-- Separates "last time we touched this report's cursor" (synced_at, bumped by
-- every fights-sync write) from "last time we actually tried a rankings
-- query" — without this, the 1h rankings-retry gate in pull-scores.ts blocks
-- the *first* rankings attempt for an hour after fights finish syncing, since
-- synced_at was just bumped by the fights-sync write itself.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0104_pull_score_rankings_attempted_at.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0104_pull_score_rankings_attempted_at.sql

ALTER TABLE pull_score_reports ADD COLUMN rankings_attempted_at INTEGER NOT NULL DEFAULT 0;
