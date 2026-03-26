-- Application submissions from the /raiding How to Apply form

CREATE TABLE IF NOT EXISTS applications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_username TEXT    NOT NULL DEFAULT '',
  battletag        TEXT    NOT NULL DEFAULT '',
  raid_history     TEXT    NOT NULL DEFAULT '',
  goals            TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'received'
                           CHECK (status IN ('received','reviewed','contacted','rejected','trial')),
  submitted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS application_characters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  char_name      TEXT    NOT NULL,
  realm          TEXT    NOT NULL DEFAULT '',
  realm_slug     TEXT    NOT NULL DEFAULT '',
  is_main        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS application_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author         TEXT    NOT NULL,
  note           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
