-- Remove duplicate loot history entries that represent the same award
-- (same player, same item, same timestamp) but have different entry_key values
-- due to different clients generating keys with differing factionRealm or key strategy.

-- Pass 1: deduplicate rows that have both awarded_at_epoch and item_id.
-- These are the most precisely identifiable; same player+item+epoch = same award.
DELETE FROM loot_history
WHERE id IN (
	SELECT id
	FROM (
		SELECT
			id,
			ROW_NUMBER() OVER (
				PARTITION BY
					LOWER(TRIM(COALESCE(owner_name, ''))),
					LOWER(TRIM(COALESCE(owner_realm, ''))),
					awarded_at_epoch,
					item_id
				ORDER BY id DESC
			) AS row_rank
		FROM loot_history
		WHERE awarded_at_epoch IS NOT NULL AND item_id IS NOT NULL
	) ranked
	WHERE ranked.row_rank > 1
);

-- Pass 2: deduplicate remaining rows without epoch or item_id using the raw loot link.
DELETE FROM loot_history
WHERE id IN (
	SELECT id
	FROM (
		SELECT
			id,
			ROW_NUMBER() OVER (
				PARTITION BY
					LOWER(TRIM(COALESCE(owner_name, ''))),
					LOWER(TRIM(COALESCE(owner_realm, ''))),
					COALESCE(awarded_date, ''),
					COALESCE(awarded_time, ''),
					LOWER(TRIM(COALESCE(loot_won_link, '')))
				ORDER BY id DESC
			) AS row_rank
		FROM loot_history
		WHERE awarded_at_epoch IS NULL OR item_id IS NULL
	) ranked
	WHERE ranked.row_rank > 1
);
