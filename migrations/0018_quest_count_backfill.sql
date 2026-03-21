ALTER TABLE roster_members_cache
ADD COLUMN quest_count_checked INTEGER NOT NULL DEFAULT 0;

UPDATE roster_members_cache
SET quest_count_checked = CASE WHEN quest_count > 0 THEN 1 ELSE 0 END;