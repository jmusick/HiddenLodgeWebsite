-- Hidden Lodge DB: per-death cache of estimated defensive-cooldown and
-- healthstone/health-potion availability at the moment of death, computed
-- lazily (on first expand of a death row on /death-analysis) from Warcraft
-- Logs cast events rather than during the cron sync.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0080_death_cooldown_cache.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0080_death_cooldown_cache.sql

-- One row per death (same key as death_analysis_events). defensives_json is a
-- JSON array of { abilityId, name, status: 'available'|'on_cooldown'|'unknown', secondsRemaining }.
CREATE TABLE IF NOT EXISTS death_cooldown_cache (
    report_code                    TEXT    NOT NULL REFERENCES death_analysis_reports(report_code) ON DELETE CASCADE,
    fight_id                       INTEGER NOT NULL,
    death_position                 INTEGER NOT NULL,
    spec_id                        INTEGER NOT NULL DEFAULT 0,
    defensives_json                TEXT    NOT NULL DEFAULT '[]',
    healthstone_status             TEXT    NOT NULL DEFAULT 'unknown',
    healthstone_seconds_remaining  INTEGER,
    health_potion_status           TEXT    NOT NULL DEFAULT 'unknown',
    health_potion_seconds_remaining INTEGER,
    computed_at                    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (report_code, fight_id, death_position)
);
