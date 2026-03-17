-- Hidden Lodge DB: admin tables
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0003_admin.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --file=migrations/0003_admin.sql

-- Represents a "player" who may own multiple roster characters.
-- Provides a grouping + nickname + admin-level main override.
-- When user_id is set AND that user has is_main=1 on a character in the group,
-- the user's choice takes priority over admin_main_blizzard_char_id.
CREATE TABLE IF NOT EXISTS member_profiles (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname                    TEXT,
    user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    admin_main_blizzard_char_id INTEGER,
    created_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at                  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Maps roster characters (from roster_members_cache) to a player profile.
-- Each character can belong to at most one profile.
CREATE TABLE IF NOT EXISTS member_profile_characters (
    blizzard_char_id  INTEGER PRIMARY KEY,
    member_profile_id INTEGER NOT NULL REFERENCES member_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_profile_chars_profile ON member_profile_characters(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_member_profiles_user_id ON member_profiles(user_id);
