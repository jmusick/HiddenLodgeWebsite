export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';
import {
	dayKeyInTimeZone,
	parseUtcTime,
	shouldScheduleOccurOnUtcDate,
	type AdHocRaid,
	type PrimarySchedule,
} from '../../../lib/raid-signups';

type SignupStatus = 'coming' | 'tentative' | 'late' | 'absent' | 'not-signed';

interface RosterRow {
	blizzard_char_id: number;
	name: string;
	realm: string;
}

interface SignupRow {
	id: number;
	signed_up_at: number;
	signup_status: Exclude<SignupStatus, 'not-signed'>;
	blizzard_char_id: number;
}

interface CalendarRaid {
	kind: 'primary' | 'adhoc';
	name: string;
	startsAtUtc: number;
	displayStartsAtUtc: number;
	primaryScheduleId: number | null;
	adHocRaidId: number | null;
}

const PRIMARY_SCHEDULE_TIME_ZONE = 'America/New_York';
const WEEKDAY_SHORT_TO_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

const tzWeekMinuteFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: PRIMARY_SCHEDULE_TIME_ZONE,
	weekday: 'short',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

function trim(value: string | null | undefined): string {
	return String(value ?? '').trim();
}

function weekMinuteInPrimaryTimeZone(epochSeconds: number): number {
	const parts = tzWeekMinuteFormatter.formatToParts(new Date(epochSeconds * 1000));
	const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
	const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
	const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
	const weekday = WEEKDAY_SHORT_TO_INDEX[weekdayShort] ?? 0;
	return weekday * 24 * 60 + hour * 60 + minute;
}

function adjustedPrimaryDisplayStartUtc(schedule: PrimarySchedule, startsAtUtc: number): number {
	const parsedTime = parseUtcTime(schedule.start_time_utc);
	if (!parsedTime) return startsAtUtc;

	const referenceSundayUtc = Math.floor(Date.UTC(2024, 0, 7, 0, 0, 0, 0) / 1000);
	const referenceSlotUtc =
		referenceSundayUtc +
		schedule.weekday_utc * 24 * 60 * 60 +
		(parsedTime.hour * 60 + parsedTime.minute) * 60;

	const intendedWeekMinute = weekMinuteInPrimaryTimeZone(referenceSlotUtc);
	const actualWeekMinute = weekMinuteInPrimaryTimeZone(startsAtUtc);

	let diffMinutes = actualWeekMinute - intendedWeekMinute;
	while (diffMinutes > (7 * 24 * 60) / 2) diffMinutes -= 7 * 24 * 60;
	while (diffMinutes < -(7 * 24 * 60) / 2) diffMinutes += 7 * 24 * 60;

	if (Math.abs(diffMinutes) > 120 || diffMinutes === 0) return startsAtUtc;
	return startsAtUtc - diffMinutes * 60;
}

function findTargetRaid(
	nowEpoch: number,
	primarySchedules: PrimarySchedule[],
	adHocRaids: AdHocRaid[]
): CalendarRaid | null {
	const windowStart = nowEpoch - 2 * 86400;
	const windowEnd = nowEpoch + 2 * 86400;
	const raids: CalendarRaid[] = [];

	const startDate = new Date(windowStart * 1000);
	const endDate = new Date(windowEnd * 1000);
	let dayCursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
	const dayEnd = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() + 1));

	for (; dayCursor < dayEnd; dayCursor = new Date(dayCursor.getTime() + 86400000)) {
		const dayStartEpoch = Math.floor(dayCursor.getTime() / 1000);
		for (const schedule of primarySchedules) {
			if (!shouldScheduleOccurOnUtcDate(schedule, dayCursor)) continue;
			const parsed = parseUtcTime(schedule.start_time_utc);
			if (!parsed) continue;

			const startsAtUtc = dayStartEpoch + parsed.hour * 3600 + parsed.minute * 60;
			raids.push({
				kind: 'primary',
				name: schedule.name,
				startsAtUtc,
				displayStartsAtUtc: adjustedPrimaryDisplayStartUtc(schedule, startsAtUtc),
				primaryScheduleId: schedule.id,
				adHocRaidId: null,
			});
		}
	}

	for (const raid of adHocRaids) {
		raids.push({
			kind: 'adhoc',
			name: raid.name,
			startsAtUtc: raid.starts_at_utc,
			displayStartsAtUtc: raid.starts_at_utc,
			primaryScheduleId: null,
			adHocRaidId: raid.id,
		});
	}

	const todayKey = dayKeyInTimeZone(nowEpoch, PRIMARY_SCHEDULE_TIME_ZONE);
	const todayRaids = raids.filter((raid) => dayKeyInTimeZone(raid.displayStartsAtUtc, PRIMARY_SCHEDULE_TIME_ZONE) === todayKey);
	if (todayRaids.length === 0) {
		return null;
	}

	todayRaids.sort((a, b) => {
		const aDelta = Math.abs(a.displayStartsAtUtc - nowEpoch);
		const bDelta = Math.abs(b.displayStartsAtUtc - nowEpoch);
		if (aDelta !== bDelta) return aDelta - bDelta;
		return a.displayStartsAtUtc - b.displayStartsAtUtc;
	});

	return todayRaids[0];
}

export async function GET(context: APIContext): Promise<Response> {
	if (!isAuthorizedDesktopRequest(context.request)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const nowEpoch = Math.floor(Date.now() / 1000);
	const adHocWindowStart = nowEpoch - 2 * 86400;
	const adHocWindowEnd = nowEpoch + 2 * 86400;

	const [schedulesResult, adHocResult, rosterResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, name, weekday_utc, start_time_utc, duration_minutes, repeat_cycle, created_at, is_active
			 FROM primary_raid_schedules
			 WHERE is_active = 1
			 ORDER BY weekday_utc ASC, start_time_utc ASC, name ASC`
		),
		env.DB.prepare(
			`SELECT id, name, starts_at_utc, duration_minutes, notes, is_active
			 FROM ad_hoc_raids
			 WHERE is_active = 1
			   AND starts_at_utc >= ?
			   AND starts_at_utc < ?
			 ORDER BY starts_at_utc ASC, name ASC`
		).bind(adHocWindowStart, adHocWindowEnd),
		env.DB.prepare(
			`SELECT DISTINCT rmc.blizzard_char_id, rmc.name, rmc.realm
			 FROM roster_members_cache rmc
			 JOIN raid_team_members rtm ON rtm.blizzard_char_id = rmc.blizzard_char_id
			 ORDER BY rmc.name ASC`
		),
	]);

	const primarySchedules = (schedulesResult.results ?? []) as PrimarySchedule[];
	const adHocRaids = (adHocResult.results ?? []) as AdHocRaid[];
	const rosterRows = (rosterResult.results ?? []) as RosterRow[];

	const targetRaid = findTargetRaid(nowEpoch, primarySchedules, adHocRaids);
	if (!targetRaid) {
		return Response.json({
			raid: null,
			entries: rosterRows.map((row) => ({
				character: trim(row.name),
				realm: trim(row.realm),
				signupStatus: 'not-signed' as SignupStatus,
				signedUpAt: null as number | null,
			})),
		});
	}

	let signupsResult;
	if (targetRaid.kind === 'primary' && targetRaid.primaryScheduleId) {
		signupsResult = await env.DB.prepare(
			`SELECT
				rs.id,
				rs.signed_up_at,
				rs.signup_status,
				c.blizzard_char_id
			 FROM raid_signups rs
			 JOIN characters c ON c.id = rs.character_id
			 WHERE rs.raid_kind = 'primary'
			   AND rs.primary_schedule_id = ?
			   AND rs.occurrence_start_utc >= ?
			   AND rs.occurrence_start_utc <= ?`
		)
			.bind(
				targetRaid.primaryScheduleId,
				targetRaid.startsAtUtc - 12 * 3600,
				targetRaid.startsAtUtc + 12 * 3600
			)
			.all<SignupRow>();
	} else {
		signupsResult = await env.DB.prepare(
			`SELECT
				rs.id,
				rs.signed_up_at,
				rs.signup_status,
				c.blizzard_char_id
			 FROM raid_signups rs
			 JOIN characters c ON c.id = rs.character_id
			 WHERE rs.raid_kind = 'adhoc'
			   AND rs.ad_hoc_raid_id = ?`
		)
			.bind(targetRaid.adHocRaidId)
			.all<SignupRow>();
	}

	const latestByBlizzardCharId = new Map<number, SignupRow>();
	for (const row of signupsResult.results ?? []) {
		const key = row.blizzard_char_id;
		const existing = latestByBlizzardCharId.get(key);
		if (!existing) {
			latestByBlizzardCharId.set(key, row);
			continue;
		}

		if (row.signed_up_at > existing.signed_up_at || (row.signed_up_at === existing.signed_up_at && row.id > existing.id)) {
			latestByBlizzardCharId.set(key, row);
		}
	}

	const entries = rosterRows.map((row) => {
		const signup = latestByBlizzardCharId.get(row.blizzard_char_id);
		const status = (signup?.signup_status ?? 'not-signed') as SignupStatus;
		const signedUpAt = signup ? Number(signup.signed_up_at) || null : null;

		return {
			character: trim(row.name),
			realm: trim(row.realm),
			signupStatus: status,
			signedUpAt,
		};
	});

	return Response.json({
		raid: {
			kind: targetRaid.kind,
			name: targetRaid.name,
			startsAtUtc: targetRaid.startsAtUtc,
			displayStartsAtUtc: targetRaid.displayStartsAtUtc,
		},
		entries,
	});
}