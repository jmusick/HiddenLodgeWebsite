-- Hidden Lodge DB: site-wide settings
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0016_site_settings.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0016_site_settings.sql

CREATE TABLE IF NOT EXISTS site_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
