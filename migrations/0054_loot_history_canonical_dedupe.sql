-- Canonicalize loot history keys and remove duplicate rows created by differing client key strategies.

DELETE FROM loot_history
WHERE id IN (
	SELECT id
	FROM (
		SELECT
			id,
			ROW_NUMBER() OVER (
				PARTITION BY
					LOWER(TRIM(COALESCE(faction_realm, ''))),
					LOWER(TRIM(COALESCE(owner_full_name, ''))),
					LOWER(TRIM(COALESCE(source_id, '')))
				ORDER BY COALESCE(synced_at, 0) DESC, id DESC
			) AS row_rank
		FROM loot_history
		WHERE TRIM(COALESCE(source_id, '')) != ''
	) ranked
	WHERE ranked.row_rank > 1
);

UPDATE loot_history
SET entry_key =
	LOWER(TRIM(COALESCE(faction_realm, '')))
	|| '|'
	|| LOWER(TRIM(COALESCE(owner_full_name, '')))
	|| '|'
	|| LOWER(TRIM(COALESCE(source_id, '')))
WHERE TRIM(COALESCE(source_id, '')) != '';
