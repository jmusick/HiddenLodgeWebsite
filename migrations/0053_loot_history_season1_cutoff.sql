-- Remove loot history records before Midnight Season 1 start: 2026-03-17 00:00:00 UTC.
DELETE FROM loot_history
WHERE COALESCE(
	awarded_at_epoch,
	CASE
		WHEN awarded_date GLOB '????/??/??' AND awarded_time GLOB '??:??*'
			THEN unixepoch(replace(awarded_date, '/', '-') || ' ' || awarded_time || ' UTC')
		ELSE NULL
	END,
	0
) < 1773705600;
