-- Boss-only Ula'tek pull snapshots fetched when a member opens Group Size Analysis.
-- Re-fetched when the source report is re-synced (for logs still growing).
CREATE TABLE IF NOT EXISTS group_size_pull_cache (
    report_code       TEXT    NOT NULL,
    fight_id          INTEGER NOT NULL,
    source_synced_at  INTEGER NOT NULL,
    payload_json      TEXT    NOT NULL,
    fetched_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (report_code, fight_id)
);
