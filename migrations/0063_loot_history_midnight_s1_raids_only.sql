-- Remove loot history rows for raids outside Midnight Season 1.
DELETE FROM loot_history
WHERE LOWER(TRIM(COALESCE(instance_name, ''))) NOT IN (
	'the voidspire',
	'the dreamrift',
	'march on quel''danas'
);