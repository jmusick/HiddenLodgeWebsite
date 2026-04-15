CREATE TABLE IF NOT EXISTS sim_raidbots_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  blizzard_char_id INTEGER NOT NULL,
  report_id        TEXT    NOT NULL,
  raid_slug        TEXT,
  difficulty       TEXT,
  report_title     TEXT,
  fetched_at       INTEGER,
  status           TEXT    NOT NULL DEFAULT 'pending',
  error_message    TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(blizzard_char_id, report_id)
);

CREATE INDEX IF NOT EXISTS idx_raidbots_reports_char ON sim_raidbots_reports(blizzard_char_id, updated_at);

CREATE TABLE IF NOT EXISTS sim_raidbots_item_scores (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  raidbots_report_id INTEGER NOT NULL REFERENCES sim_raidbots_reports(id) ON DELETE CASCADE,
  blizzard_char_id   INTEGER NOT NULL,
  item_id            INTEGER NOT NULL,
  delta_dps          REAL    NOT NULL,
  pct_gain           REAL,
  slot               TEXT,
  ilvl               INTEGER,
  difficulty         TEXT,
  UNIQUE(raidbots_report_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_raidbots_scores_char ON sim_raidbots_item_scores(blizzard_char_id);
CREATE INDEX IF NOT EXISTS idx_raidbots_scores_item ON sim_raidbots_item_scores(item_id);
