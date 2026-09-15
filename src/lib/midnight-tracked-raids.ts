export const MIDNIGHT_SEASON_ONE_RAID_NAMES = [
	'The Voidspire',
	'The Dreamrift',
	"March on Quel'Danas",
] as const;

export const MIDNIGHT_SEASON_TWO_RAID_NAMES = ['The Venomous Abyss'] as const;

export const MIDNIGHT_TRACKED_RAID_NAMES = [
	...MIDNIGHT_SEASON_ONE_RAID_NAMES,
	...MIDNIGHT_SEASON_TWO_RAID_NAMES,
] as const;

export function normalizeMidnightRaidName(value: string | null | undefined): string {
	const normalized = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/\s+/g, ' ');

	return normalized.replace(/-(normal|heroic|mythic|lfr)$/i, '');
}

export const MIDNIGHT_TRACKED_NORMALIZED_RAID_NAMES = MIDNIGHT_TRACKED_RAID_NAMES.map((name) =>
	normalizeMidnightRaidName(name)
);

const MIDNIGHT_TRACKED_RAID_NAME_SET = new Set(MIDNIGHT_TRACKED_NORMALIZED_RAID_NAMES);

export function isMidnightTrackedRaid(value: string | null | undefined): boolean {
	return MIDNIGHT_TRACKED_RAID_NAME_SET.has(normalizeMidnightRaidName(value));
}
