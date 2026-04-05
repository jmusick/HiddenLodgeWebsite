CREATE TABLE IF NOT EXISTS guild_feedback (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name  TEXT,
    message       TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed')),
    submitted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    reviewed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_guild_feedback_submitted_at
ON guild_feedback(submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_guild_feedback_status_submitted
ON guild_feedback(status, submitted_at DESC);
