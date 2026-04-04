export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';
import { getAttendanceSummaryMap } from '../../../lib/attendance';
import { getVaultHistory } from '../../../lib/raiders';

const US_WEEKLY_RESET_HOUR_EASTERN = 10;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function easternUtcOffsetMinutes(atUtc: Date): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		timeZoneName: 'shortOffset',
		hour: '2-digit',
	}).formatToParts(atUtc);

	const offsetLabel = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5';
	const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
	if (!match) return -300;

	const sign = match[1] === '-' ? -1 : 1;
	const hours = Number(match[2] ?? '0');
	const minutes = Number(match[3] ?? '0');
	return sign * (hours * 60 + minutes);
}

// US weekly reset bucket: Tuesday 10:00 AM America/New_York.
function getUsWeeklyResetTimestamp(): number {
	const now = new Date();
	const nowParts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		weekday: 'short',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(now);

	const weekdayShort = nowParts.find((part) => part.type === 'weekday')?.value ?? 'Tue';
	const year = Number(nowParts.find((part) => part.type === 'year')?.value ?? '1970');
	const month = Number(nowParts.find((part) => part.type === 'month')?.value ?? '1');
	const day = Number(nowParts.find((part) => part.type === 'day')?.value ?? '1');

	const weekdayToIndex: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const dayIndex = weekdayToIndex[weekdayShort] ?? 2;
	const daysSinceTuesday = (dayIndex - 2 + 7) % 7;

	const localResetSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday, US_WEEKLY_RESET_HOUR_EASTERN, 0, 0, 0));
	const offsetMinutes = easternUtcOffsetMinutes(localResetSeedUtc);
	let resetUtc = new Date(localResetSeedUtc.getTime() - offsetMinutes * 60 * 1000);

	if (resetUtc > now) {
		const previousWeekLocalSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday - 7, US_WEEKLY_RESET_HOUR_EASTERN, 0, 0, 0));
		const previousWeekOffsetMinutes = easternUtcOffsetMinutes(previousWeekLocalSeedUtc);
		resetUtc = new Date(previousWeekLocalSeedUtc.getTime() - previousWeekOffsetMinutes * 60 * 1000);
	}

	return Math.floor(resetUtc.getTime() / 1000);
}

function isPostResetThisCalendarWeek(now: Date): boolean {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		weekday: 'short',
		hour: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(now);

	const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Tue';
	const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');

	if (weekday === 'Sun' || weekday === 'Mon') {
		return false;
	}

	if (weekday === 'Tue') {
		return hour >= US_WEEKLY_RESET_HOUR_EASTERN;
	}

	return true;
}

// ---- Row types used by desktop preparedness sync ----

interface CharRow {
	blizzard_char_id: number;
	name: string;
	realm: string;
	socketed_gems: number | null;
	total_sockets: number | null;
	enchanted_slots: number | null;
	enchantable_slots: number | null;
	avg_30d_socketed_gems: number | null;
	avg_30d_total_sockets: number | null;
	avg_30d_enchanted_slots: number | null;
	avg_30d_enchantable_slots: number | null;
}

// ---- Preparedness tier calculation ----

function preparednessTier(char: CharRow): string {
	const socketedGems = char.avg_30d_socketed_gems ?? char.socketed_gems;
	const totalSockets = char.avg_30d_total_sockets ?? char.total_sockets;
	const enchantedSlots = char.avg_30d_enchanted_slots ?? char.enchanted_slots;
	const enchantableSlots = char.avg_30d_enchantable_slots ?? char.enchantable_slots;

	if (socketedGems === null || totalSockets === null || enchantedSlots === null || enchantableSlots === null) {
		return '—';
	}

	const filled = socketedGems + enchantedSlots;
	const total = totalSockets + enchantableSlots;
	if (total === 0) return 'N/A';

	const pct = filled / total;
	if (pct >= 1) return 'S Tier';
	if (pct >= 0.85) return 'A Tier';
	if (pct >= 0.7) return 'B Tier';
	if (pct >= 0.4) return 'C Tier';
	return 'D Tier';
}

const VAULT_SLOT_POSITION_WEIGHTS = [1, 1.35, 1.8] as const;

function raidDifficultyWeight(itemLevel: number | null): number {
	if (itemLevel === null) return 0;
	if (itemLevel >= 272) return 1.45;
	if (itemLevel >= 266) return 1.25;
	if (itemLevel >= 259) return 1.0;
	if (itemLevel >= 252) return 0.75;
	return 0.6;
}

function dungeonDifficultyWeight(itemLevel: number | null): number {
	if (itemLevel === null) return 0;
	if (itemLevel >= 272) return 1.45;
	if (itemLevel >= 269) return 1.3;
	if (itemLevel >= 266) return 1.15;
	if (itemLevel >= 263) return 1.0;
	if (itemLevel >= 259) return 0.85;
	return 0.7;
}

function greatVaultScore(char: CharRow): number | null {
	const raidSlots = [char.raid_slot_1_ilvl, char.raid_slot_2_ilvl, char.raid_slot_3_ilvl] as const;
	const dungeonSlots = [char.dungeon_slot_1_ilvl, char.dungeon_slot_2_ilvl, char.dungeon_slot_3_ilvl] as const;
	const worldSlotsFilled = Math.max(0, Math.min(3, char.world_slots_filled ?? 0));
	const hasVaultData =
		raidSlots.some((slot) => slot !== null)
		|| dungeonSlots.some((slot) => slot !== null)
		|| worldSlotsFilled > 0;

	if (!hasVaultData) {
		return null;
	}

	let points = 0;
	let maxPoints = 0;

	for (let i = 0; i < 3; i += 1) {
		const slotWeight = VAULT_SLOT_POSITION_WEIGHTS[i];
		points += raidDifficultyWeight(raidSlots[i]) * slotWeight;
		points += dungeonDifficultyWeight(dungeonSlots[i]) * slotWeight;
		maxPoints += 1.45 * slotWeight;
		maxPoints += 1.45 * slotWeight;

		if (worldSlotsFilled > i) {
			points += 0.35 * slotWeight;
		}
		maxPoints += 0.35 * slotWeight;
	}

	if (maxPoints <= 0) {
		return null;
	}

	return Math.round((points / maxPoints) * 100);
}

// ---- Handler ----

export async function GET(context: APIContext): Promise<Response> {
	if (!isAuthorizedDesktopRequest(context.request)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const now = new Date();
	const currentWeekStartTs = getUsWeeklyResetTimestamp();
	const targetLastWeekStartTs = isPostResetThisCalendarWeek(now)
		? currentWeekStartTs - WEEK_SECONDS
		: currentWeekStartTs;
	const targetLastWeekEndTs = targetLastWeekStartTs + WEEK_SECONDS;

	const result = await env.DB.prepare(`
		SELECT
			c.blizzard_char_id,
			c.name,
			c.realm,
			mc.socketed_gems,
			mc.total_sockets,
			mc.enchanted_slots,
			mc.enchantable_slots,
			mc.avg_30d_socketed_gems,
			mc.avg_30d_total_sockets,
			mc.avg_30d_enchanted_slots,
			mc.avg_30d_enchantable_slots
		FROM characters c
		JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
		LEFT JOIN raider_metrics_cache mc ON mc.blizzard_char_id = c.blizzard_char_id
		ORDER BY c.name ASC
	`).all<CharRow>();

	const vaultHistoryByCharId = new Map<number, Awaited<ReturnType<typeof getVaultHistory>>[number] | null>();
	const attendanceSummaryByCharId = await getAttendanceSummaryMap(env.DB);
	await Promise.all((result.results ?? []).map(async (char) => {
		const history = await getVaultHistory(char.blizzard_char_id, env.DB);
		const targetRow = isPostResetThisCalendarWeek(now)
			? history.find((row) => row.weekStartTs < currentWeekStartTs) ?? null
			: history.find((row) => row.weekStartTs === currentWeekStartTs) ?? history[0] ?? null;
		vaultHistoryByCharId.set(char.blizzard_char_id, targetRow);
	}));

	const entries = (result.results ?? []).map((char) => {
		const vaultRow = vaultHistoryByCharId.get(char.blizzard_char_id);
		const effective = vaultRow
			? {
				raid_slot_1_ilvl: vaultRow.raidSlot1Ilvl,
				raid_slot_2_ilvl: vaultRow.raidSlot2Ilvl,
				raid_slot_3_ilvl: vaultRow.raidSlot3Ilvl,
				dungeon_slot_1_ilvl: vaultRow.dungeonSlot1Ilvl,
				dungeon_slot_2_ilvl: vaultRow.dungeonSlot2Ilvl,
				dungeon_slot_3_ilvl: vaultRow.dungeonSlot3Ilvl,
				world_slots_filled: vaultRow.worldSlotsFilled,
			}
			: {
				raid_slot_1_ilvl: null,
				raid_slot_2_ilvl: null,
				raid_slot_3_ilvl: null,
				dungeon_slot_1_ilvl: null,
				dungeon_slot_2_ilvl: null,
				dungeon_slot_3_ilvl: null,
				world_slots_filled: 0,
			};

		return {
			character: char.name,
			realm: char.realm,
			preparednessTier: preparednessTier(char),
			greatVaultScore: greatVaultScore(effective),
			attendanceScore: attendanceSummaryByCharId.get(char.blizzard_char_id)?.scorePercent ?? null,
		};
	});

	return Response.json(entries, {
		headers: {
			'Cache-Control': 'no-store, max-age=0',
		},
	});
}
