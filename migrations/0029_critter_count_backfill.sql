ALTER TABLE roster_members_cache
ADD COLUMN critter_checked INTEGER NOT NULL DEFAULT 0;

UPDATE roster_members_cache
SET critter_checked = CASE WHEN critter_count > 0 THEN 1 ELSE 0 END;