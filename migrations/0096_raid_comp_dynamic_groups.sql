-- Hidden Lodge DB: permit Raid Comp to add groups beyond the original four-group cap.
-- Run locally:  npm run db:migrate:local -- migrations/0096_raid_comp_dynamic_groups.sql
-- Run in prod:  npm run db:migrate:prod -- migrations/0096_raid_comp_dynamic_groups.sql
-- allow-destructive

CREATE TABLE raid_comp_assignments_new (
    blizzard_char_id    INTEGER PRIMARY KEY,
    raid_group          INTEGER NOT NULL CHECK (raid_group >= 1),
    updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO raid_comp_assignments_new (blizzard_char_id, raid_group, updated_by_user_id, updated_at)
SELECT blizzard_char_id, raid_group, updated_by_user_id, updated_at
FROM raid_comp_assignments;

DROP TABLE raid_comp_assignments;
ALTER TABLE raid_comp_assignments_new RENAME TO raid_comp_assignments;
