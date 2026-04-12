CREATE TABLE IF NOT EXISTS sim_item_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_run_id INTEGER NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  blizzard_char_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  item_id INTEGER,
  item_label TEXT,
  ilvl REAL,
  source TEXT,
  delta_dps REAL,
  pct_gain REAL,
  simc TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_item_scores_run ON sim_item_scores(sim_run_id);
CREATE INDEX IF NOT EXISTS idx_sim_item_scores_char_item ON sim_item_scores(blizzard_char_id, item_id);
