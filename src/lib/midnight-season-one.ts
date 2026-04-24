export const MIDNIGHT_SEASON_ONE_RAID_NAMES = [
	'The Voidspire',
	'The Dreamrift',
	"March on Quel'Danas",
] as const;

export function normalizeMidnightSeasonOneRaidName(value: string | null | undefined): string {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/\s+/g, ' ');
}

export const MIDNIGHT_SEASON_ONE_NORMALIZED_RAID_NAMES = MIDNIGHT_SEASON_ONE_RAID_NAMES.map((name) =>
	normalizeMidnightSeasonOneRaidName(name)
);

const MIDNIGHT_SEASON_ONE_RAID_NAME_SET = new Set(MIDNIGHT_SEASON_ONE_NORMALIZED_RAID_NAMES);

export function isMidnightSeasonOneRaid(value: string | null | undefined): boolean {
	return MIDNIGHT_SEASON_ONE_RAID_NAME_SET.has(normalizeMidnightSeasonOneRaidName(value));
}