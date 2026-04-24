-- Remove loot history rows for raids outside Midnight Season 1.
DELETE FROM loot_history
WHERE NOT (
	LOWER(TRIM(COALESCE(instance_name, ''))) = 'the voidspire'
	OR LOWER(TRIM(COALESCE(instance_name, ''))) LIKE 'the voidspire-%'
	OR LOWER(TRIM(COALESCE(instance_name, ''))) = 'the dreamrift'
	OR LOWER(TRIM(COALESCE(instance_name, ''))) LIKE 'the dreamrift-%'
	OR LOWER(TRIM(COALESCE(instance_name, ''))) = 'march on quel''danas'
	OR LOWER(TRIM(COALESCE(instance_name, ''))) LIKE 'march on quel''danas-%'
);