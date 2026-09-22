-- Hidden Lodge DB: Pull Score — a recency-weighted, per-pull performance score
-- computed from WCL `table` data, replacing WCL's all-time Parse as the Raid
-- Comp scoring input. Reuses Death Analysis's canonical raid-night reports.
-- See TODO.md "Pull Score & Parse Analysis" for the full plan.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0103_pull_scores.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0103_pull_scores.sql

-- One row per raider per pull. Every qualifying Heroic pull >= 30s (kills and
-- wipes); wcl_percent is NULL on wipes since WCL's public API exposes no
-- wipe parse.
CREATE TABLE IF NOT EXISTS pull_score_pulls (
    report_code       TEXT    NOT NULL,
    fight_id          INTEGER NOT NULL,
    blizzard_char_id  INTEGER NOT NULL,
    encounter_id      INTEGER NOT NULL,
    encounter_name    TEXT    NOT NULL,
    difficulty        INTEGER NOT NULL,
    is_kill           INTEGER NOT NULL DEFAULT 0,
    boss_percent      REAL    NOT NULL DEFAULT 0,
    fight_end_utc     INTEGER NOT NULL,
    -- tank | healer | dps: the raider's role on this pull.
    role              TEXT    NOT NULL,
    -- DPS for tanks/dps, HPS for healers; total (incl. pets) / fight duration.
    amount            REAL    NOT NULL,
    role_median       REAL    NOT NULL,
    role_count        INTEGER NOT NULL,
    pull_score        REAL    NOT NULL,
    -- WCL bracketPercent for this pull; NULL on wipes (kills only).
    wcl_percent       REAL,
    PRIMARY KEY (report_code, fight_id, blizzard_char_id)
);

CREATE INDEX IF NOT EXISTS idx_pull_score_pulls_char
ON pull_score_pulls(blizzard_char_id);

-- Sync cursor, one row per report, so a long night finishes over several runs.
CREATE TABLE IF NOT EXISTS pull_score_reports (
    report_code      TEXT    PRIMARY KEY,
    total_fights     INTEGER NOT NULL DEFAULT 0,
    synced_fights    INTEGER NOT NULL DEFAULT 0,
    rankings_synced  INTEGER NOT NULL DEFAULT 0,
    synced_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
