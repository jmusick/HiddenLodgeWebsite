-- allow-destructive
-- Pull Score's formula changed: it's now WCL's own bracketPercent (kills
-- only), decay-weighted by recency, instead of a from-scratch per-pull
-- role-median comparison. See TODO.md "Pull Score & Parse Analysis" and the
-- session notes around 2026-09-22 for why (a same-spec median collapses to a
-- trivial 50 whenever only one guildmate plays that spec — WCL's own
-- percentile, normalized against a worldwide population, doesn't have that
-- problem). pull_score now has to allow NULL (wipes, and kills WCL hasn't
-- ranked yet), which the original 0103 NOT NULL constraint blocks — SQLite
-- has no ALTER COLUMN, so the table is dropped and recreated. All of this is
-- synced/cached data, fully rebuilt by the next few refreshPullScores runs;
-- nothing here is user input.
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0105_pull_score_nullable.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0105_pull_score_nullable.sql

DROP INDEX IF EXISTS idx_pull_score_pulls_char;
DROP TABLE IF EXISTS pull_score_pulls;

CREATE TABLE pull_score_pulls (
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
    -- Display context only (pull history) — no longer feeds the score.
    amount            REAL    NOT NULL,
    role_median       REAL    NOT NULL,
    role_count        INTEGER NOT NULL,
    -- WCL bracketPercent for this pull, decay-weighted elsewhere into the
    -- raider's overall Pull Score. NULL on wipes and on kills WCL hasn't
    -- ranked yet.
    pull_score        REAL,
    PRIMARY KEY (report_code, fight_id, blizzard_char_id)
);

CREATE INDEX idx_pull_score_pulls_char
ON pull_score_pulls(blizzard_char_id);

-- Force every report to resync fully under the new formula.
DELETE FROM pull_score_reports;
