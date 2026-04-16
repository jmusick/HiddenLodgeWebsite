CREATE TABLE IF NOT EXISTS item_icon_cache (
  item_id INTEGER PRIMARY KEY,
  icon_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
