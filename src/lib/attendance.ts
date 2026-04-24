import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';

export type AttendanceSignupStatus = 'coming' | 'tentative' | 'late' | 'absent' | 'unsigned';

export interface AttendanceRaidBreakdown {
  raidRefKey: string;
  raidKind: 'primary' | 'adhoc';
  primaryScheduleId: number | null;
  adHocRaidId: number | null;
  occurrenceStartUtc: number;
  bossKillsPresent: number;
  bossKills: number;
  bossWipes: number;
  totalBosses: number;
  bossesPresent: number;
  bossesMissed: number;
  signupStatus: AttendanceSignupStatus;
  isBench: boolean;
  pointsEarned: number;
  pointsPossible: number;
  benchBonusPoints: number;
}

export interface AttendanceSummary {
  scorePercent: number;
  totalPointsEarned: number;
  totalPointsPossible: number;
  totalBenchBonusPoints: number;
  scoredRaidCount: number;
  breakdown: AttendanceRaidBreakdown[];
}

interface AttendanceReportRow {
  id: number;
  raid_ref_key: string;
  raid_kind: 'primary' | 'adhoc';
  primary_schedule_id: number | null;
  ad_hoc_raid_id: number | null;
  occurrence_start_utc: number;
  report_code: string | null;
  total_boss_kills: number;
  total_boss_wipes: number | null;
  total_wipe_pulls: number | null;
}

interface AttendanceParticipantRow {
  report_id: number;
  blizzard_char_id: number;
  bosses_present: number;
  boss_kills_present: number | null;
}

interface AttendanceSignupRow {
  raid_ref_key: string;
  occurrence_start_utc: number;
  blizzard_char_id: number;
  signup_status: 'coming' | 'tentative' | 'late' | 'absent';
}

interface AttendanceOverrideRow {
  raid_ref_key: string;
  occurrence_start_utc: number;
  blizzard_char_id: number;
}

interface AttendanceRosterTeamMemberRow {
  blizzard_char_id: number;
  joined_at_utc: number;
}

interface AttendanceCharacterRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  user_id: number | null;
}

interface AttendanceRaiderLookupRow {
  blizzard_char_id: number;
  name: string;
  realm_slug: string;
}

interface AttendanceOwnershipData {
  raiderCharIds: number[];
  charLookup: Map<string, number>;
  nameOnlyLookup: Map<string, number>;
  ownerKeyByCharId: Map<number, string>;
  charIdsByOwnerKey: Map<string, number[]>;
}

interface AttendanceOccurrence {
  raid_ref_key: string;
  raid_kind: 'primary' | 'adhoc';
  primary_schedule_id: number | null;
  ad_hoc_raid_id: number | null;
  occurrence_start_utc: number;
  scheduled_duration_minutes: number;
}

interface AttendanceDeathAggregate {
  fightsPresent: number;
  totalDeaths: number;
  firstDeathCount: number;
  secondDeathCount: number;
  thirdDeathCount: number;
  fourthDeathCount: number;
}

interface WclAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface WclReportSummary {
  code: string;
  startTime: number;
  endTime: number;
}

interface WclFightRow {
  id: number;
  startTime: number;
  endTime: number;
  encounterID?: number;
  kill?: boolean;
}

interface WclActorRow {
  id: number;
  name?: string;
  server?: string;
}

const ATTENDANCE_SCORING_START_UTC = Math.floor(Date.UTC(2026, 3, 2, 0, 0, 0, 0) / 1000);
const ATTENDANCE_BASE_POINTS = 100;
const ATTENDANCE_BENCH_BONUS_POINTS = 12;
const ATTENDANCE_COMING_NO_SHOW_PENALTY_POINTS = 30;
const ATTENDANCE_STATUS_WEIGHT: Record<Exclude<AttendanceSignupStatus, 'unsigned'>, number> = {
  coming: 1.0,
  tentative: 0.9,
  late: 0.9,
  absent: 0.8,
};
const ATTENDANCE_UNSIGNED_WEIGHT = 0.3;
const ATTENDANCE_SYNC_TTL_SECONDS = 6 * 60 * 60;
const ATTENDANCE_ZERO_RESULT_RETRY_SECONDS = 15 * 60;
const ATTENDANCE_SYNC_BATCH_SIZE = 6;
const ATTENDANCE_RAID_NIGHT_TIME_ZONE = 'America/New_York';
const ATTENDANCE_WCL_BACKOFF_KEY = 'attendance_wcl_backoff_until';
const ATTENDANCE_WCL_RATE_LIMIT_BACKOFF_SECONDS = 15 * 60;
const ATTENDANCE_WCL_MAX_BACKOFF_SECONDS = 2 * 60 * 60;
const MIDNIGHT_S1_RAID_NAMES = new Set([
  'the voidspire',
  'the dreamrift',
  "march on quel'danas",
]);

const WCL_OAUTH_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_GRAPHQL_URL = 'https://www.warcraftlogs.com/api/v2/client';
const WCL_GUILD_ID = 781707;

let wclTokenCache: { accessToken: string; expiresAt: number } | null = null;
let midnightS1EncounterIdsCache: Set<number> | null = null;
const attendanceNightFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATTENDANCE_RAID_NIGHT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

class WclRateLimitError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Warcraft Logs API rate limit reached (429).');
    this.name = 'WclRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;

  const asSeconds = Number.parseInt(value, 10);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return asSeconds;
  }

  const asDate = Date.parse(value);
  if (!Number.isFinite(asDate)) return null;
  const diffSeconds = Math.floor((asDate - Date.now()) / 1000);
  return diffSeconds > 0 ? diffSeconds : null;
}

async function getWclBackoffUntil(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM site_settings WHERE key = ? LIMIT 1`)
    .bind(ATTENDANCE_WCL_BACKOFF_KEY)
    .first<{ value: string | null }>();

  const parsed = Number.parseInt((row?.value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function setWclBackoffUntil(db: D1Database, untilEpoch: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(ATTENDANCE_WCL_BACKOFF_KEY, String(untilEpoch))
    .run();
}

async function clearWclBackoff(db: D1Database): Promise<void> {
  await db
    .prepare(`DELETE FROM site_settings WHERE key = ?`)
    .bind(ATTENDANCE_WCL_BACKOFF_KEY)
    .run();
}

function toRaidRefKey(raidKind: 'primary' | 'adhoc', primaryScheduleId: number | null, adHocRaidId: number | null): string {
  return raidKind === 'primary' ? `primary:${primaryScheduleId ?? 0}` : `adhoc:${adHocRaidId ?? 0}`;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function normalizeRealmSlug(realm: string | null | undefined): string {
  return (realm ?? '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function createAttendanceDeathAggregate(): AttendanceDeathAggregate {
  return {
    fightsPresent: 0,
    totalDeaths: 0,
    firstDeathCount: 0,
    secondDeathCount: 0,
    thirdDeathCount: 0,
    fourthDeathCount: 0,
  };
}

function attendanceOwnerKey(userId: number | null | undefined, blizzardCharId: number): string {
  return Number.isInteger(userId) && (userId ?? 0) > 0 ? `user:${userId}` : `char:${blizzardCharId}`;
}

function addCharIdToOwnerMap(charIdsByOwnerKey: Map<string, Set<number>>, ownerKey: string, blizzardCharId: number): void {
  let ownedCharIds = charIdsByOwnerKey.get(ownerKey);
  if (!ownedCharIds) {
    ownedCharIds = new Set<number>();
    charIdsByOwnerKey.set(ownerKey, ownedCharIds);
  }
  ownedCharIds.add(blizzardCharId);
}

function addUniqueNameLookup(nameLookup: Map<string, number | null>, normalizedName: string, blizzardCharId: number): void {
  if (!normalizedName) return;

  const existing = nameLookup.get(normalizedName);
  if (existing === undefined) {
    nameLookup.set(normalizedName, blizzardCharId);
    return;
  }

  if (existing !== blizzardCharId) {
    // Only keep name-only fallback when the name uniquely identifies one character.
    nameLookup.set(normalizedName, null);
  }
}

async function loadAttendanceOwnership(db: D1Database): Promise<AttendanceOwnershipData> {
  const [characterRowsResult, raiderRowsResult] = await Promise.all([
    db
      .prepare(
        `SELECT
           blizzard_char_id,
           name,
           realm,
           user_id
         FROM characters
         WHERE blizzard_char_id IS NOT NULL`
      )
      .all<AttendanceCharacterRow>(),
    db
      .prepare(
        `SELECT
           blizzard_char_id,
           name,
           realm_slug
         FROM raider_metrics_cache`
      )
      .all<AttendanceRaiderLookupRow>(),
  ]);

  const charLookup = new Map<string, number>();
  const nameOnlyLookupMutable = new Map<string, number | null>();
  const ownerKeyByCharId = new Map<number, string>();
  const charIdsByOwnerKeyMutable = new Map<string, Set<number>>();

  for (const row of characterRowsResult.results ?? []) {
    const blizzardCharId = Number(row.blizzard_char_id);
    if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) continue;

    const ownerKey = attendanceOwnerKey(row.user_id, blizzardCharId);
    ownerKeyByCharId.set(blizzardCharId, ownerKey);
    addCharIdToOwnerMap(charIdsByOwnerKeyMutable, ownerKey, blizzardCharId);

    addUniqueNameLookup(nameOnlyLookupMutable, normalizeName(row.name), blizzardCharId);

    const lookupKey = `${normalizeName(row.name)}::${normalizeRealmSlug(row.realm)}`;
    if (!lookupKey.startsWith('::')) {
      charLookup.set(lookupKey, blizzardCharId);
    }
  }

  const raiderCharIds: number[] = [];
  for (const row of raiderRowsResult.results ?? []) {
    const blizzardCharId = Number(row.blizzard_char_id);
    if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) continue;

    raiderCharIds.push(blizzardCharId);

    const existingOwnerKey = ownerKeyByCharId.get(blizzardCharId) ?? attendanceOwnerKey(null, blizzardCharId);
    ownerKeyByCharId.set(blizzardCharId, existingOwnerKey);
    addCharIdToOwnerMap(charIdsByOwnerKeyMutable, existingOwnerKey, blizzardCharId);

    addUniqueNameLookup(nameOnlyLookupMutable, normalizeName(row.name), blizzardCharId);

    const lookupKey = `${normalizeName(row.name)}::${normalizeRealmSlug(row.realm_slug)}`;
    if (!lookupKey.startsWith('::') && !charLookup.has(lookupKey)) {
      charLookup.set(lookupKey, blizzardCharId);
    }
  }

  return {
    raiderCharIds,
    charLookup,
    nameOnlyLookup: new Map(
      [...nameOnlyLookupMutable.entries()]
        .filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) > 0)
    ),
    ownerKeyByCharId,
    charIdsByOwnerKey: new Map(
      [...charIdsByOwnerKeyMutable.entries()].map(([ownerKey, charIds]) => [ownerKey, [...charIds].sort((a, b) => a - b)])
    ),
  };
}

function getWclAuthConfig(): WclAuthConfig | null {
  const clientId = (env.WCL_CLIENT_ID ?? '').trim();
  const clientSecret = (env.WCL_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function getWclAccessToken(config: WclAuthConfig): Promise<string | null> {
  const now = Date.now();
  if (wclTokenCache && wclTokenCache.expiresAt > now) {
    return wclTokenCache.accessToken;
  }

  const response = await fetch(WCL_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) return null;
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  const accessToken = (payload.access_token ?? '').trim();
  if (!accessToken) return null;

  const expiresIn = Number(payload.expires_in ?? 0);
  wclTokenCache = {
    accessToken,
    expiresAt: now + Math.max(60, expiresIn - 60) * 1000,
  };

  return accessToken;
}

async function queryWcl<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const response = await fetch(WCL_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After')) ?? ATTENDANCE_WCL_RATE_LIMIT_BACKOFF_SECONDS;
      throw new WclRateLimitError(retryAfterSeconds);
    }
    return null;
  }
  const payload = (await response.json()) as { data?: T; errors?: unknown[] };
  if ((payload.errors?.length ?? 0) > 0) return null;
  return payload.data ?? null;
}

async function listUnsignedRaidOccurrencesNeedingSync(
  db: D1Database,
  staleCutoff: number,
  nowEpoch: number,
  zeroResultCutoff: number
): Promise<AttendanceOccurrence[]> {
  const result = await db
    .prepare(
      `WITH occurrences AS (
         SELECT DISTINCT
           CASE WHEN rs.raid_kind = 'primary' THEN 'primary:' || CAST(rs.primary_schedule_id AS TEXT) ELSE 'adhoc:' || CAST(rs.ad_hoc_raid_id AS TEXT) END AS raid_ref_key,
           rs.raid_kind,
           rs.primary_schedule_id,
           rs.ad_hoc_raid_id,
             CASE WHEN rs.raid_kind = 'primary' THEN rs.occurrence_start_utc ELSE ah.starts_at_utc END AS occurrence_start_utc,
             CASE WHEN rs.raid_kind = 'primary' THEN COALESCE(prs.duration_minutes, 180) ELSE COALESCE(ah.duration_minutes, 180) END AS scheduled_duration_minutes
         FROM raid_signups rs
           LEFT JOIN primary_raid_schedules prs ON prs.id = rs.primary_schedule_id
         LEFT JOIN ad_hoc_raids ah ON ah.id = rs.ad_hoc_raid_id
         WHERE (
           (rs.raid_kind = 'primary' AND rs.occurrence_start_utc IS NOT NULL)
           OR
           (rs.raid_kind = 'adhoc' AND ah.starts_at_utc IS NOT NULL)
         )
       )
         SELECT o.raid_ref_key, o.raid_kind, o.primary_schedule_id, o.ad_hoc_raid_id, o.occurrence_start_utc, o.scheduled_duration_minutes
       FROM occurrences o
       LEFT JOIN raid_attendance_reports ar
         ON ar.raid_ref_key = o.raid_ref_key
        AND ar.occurrence_start_utc = o.occurrence_start_utc
       WHERE o.occurrence_start_utc >= ?
         AND o.occurrence_start_utc <= ?
         AND (
           ar.id IS NULL
           OR ar.total_boss_wipes IS NULL
           OR ar.total_wipe_pulls IS NULL
           OR ar.death_stats_synced_at IS NULL
           OR (
             ar.death_stats_synced_at IS NOT NULL
             AND (ar.total_boss_kills + COALESCE(ar.total_boss_wipes, 0)) > 0
             AND NOT EXISTS (
               SELECT 1 FROM raid_attendance_death_stats ds WHERE ds.report_id = ar.id LIMIT 1
             )
           )
           OR EXISTS (
             SELECT 1
             FROM raid_attendance_participants ap
             WHERE ap.report_id = ar.id
               AND ap.boss_kills_present IS NULL
             LIMIT 1
           )
           OR ar.synced_at < ?
           OR ((ar.total_boss_kills + COALESCE(ar.total_boss_wipes, 0)) = 0 AND ar.synced_at < ?)
         )
       ORDER BY o.occurrence_start_utc ASC
       LIMIT ?`
    )
    .bind(ATTENDANCE_SCORING_START_UTC, nowEpoch, staleCutoff, zeroResultCutoff, ATTENDANCE_SYNC_BATCH_SIZE)
    .all<AttendanceOccurrence>();

  return result.results ?? [];
}

async function listCandidateReportsForOccurrence(
  accessToken: string,
  occurrenceStartUtc: number,
  scheduledDurationMinutes: number
): Promise<WclReportSummary[]> {
  const safeDurationMinutes = Number.isFinite(scheduledDurationMinutes) && scheduledDurationMinutes > 0
    ? scheduledDurationMinutes
    : 180;
  const occurrenceEndUtc = occurrenceStartUtc + safeDurationMinutes * 60;
  const targetEndTimeMs = occurrenceEndUtc * 1000;

  // Raid logs are typically uploaded after the scheduled end, so search around end-time.
  const startTimeMs = (occurrenceEndUtc - 8 * 60 * 60) * 1000;
  const endTimeMs = (occurrenceEndUtc + 8 * 60 * 60) * 1000;

  const payload = await queryWcl<{
    reportData?: {
      reports?: {
        data?: Array<{ code?: string; startTime?: number; endTime?: number }>;
      };
    };
  }>(
    accessToken,
    `
      query AttendanceReports($guildID: Int!, $startTime: Float!, $endTime: Float!, $limit: Int!) {
        reportData {
          reports(guildID: $guildID, startTime: $startTime, endTime: $endTime, limit: $limit, page: 1) {
            data {
              code
              startTime
              endTime
            }
          }
        }
      }
    `,
    {
      guildID: WCL_GUILD_ID,
      startTime: startTimeMs,
      endTime: endTimeMs,
      limit: 30,
    }
  );

  const rows = payload?.reportData?.reports?.data ?? [];
  return rows
    .map((row) => {
      const code = (row.code ?? '').trim();
      const startTime = Number(row.startTime ?? 0);
      const endTime = Number(row.endTime ?? 0);
      if (!code || !Number.isFinite(startTime) || startTime <= 0) return null;
      return {
        code,
        startTime,
        endTime: Number.isFinite(endTime) && endTime > startTime ? endTime : startTime,
      } as WclReportSummary;
    })
    .filter((row): row is WclReportSummary => row !== null)
    .sort((a, b) => {
      const endDelta = Math.abs(a.endTime - targetEndTimeMs) - Math.abs(b.endTime - targetEndTimeMs);
      if (endDelta !== 0) return endDelta;
      return Math.abs(a.startTime - occurrenceStartUtc * 1000) - Math.abs(b.startTime - occurrenceStartUtc * 1000);
    });
}

async function getMidnightS1EncounterIds(accessToken: string): Promise<Set<number>> {
  if (midnightS1EncounterIdsCache) {
    return midnightS1EncounterIdsCache;
  }

  const payload = await queryWcl<{
    worldData?: {
      expansions?: Array<{ id?: number }>;
    };
  }>(
    accessToken,
    `
      query AttendanceExpansions {
        worldData {
          expansions {
            id
          }
        }
      }
    `,
    {}
  );

  const expansionIds = (payload?.worldData?.expansions ?? [])
    .map((row) => Number(row.id ?? 0))
    .filter((id) => Number.isFinite(id) && id > 0)
    .sort((a, b) => b - a);

  const preferredExpansionIds = expansionIds.length > 0 ? [expansionIds[0], null] : [null];
  const encounterIds = new Set<number>();

  for (const expansionId of preferredExpansionIds) {
    const zonesPayload = await queryWcl<{
      worldData?: {
        zones?: Array<{
          name?: string;
          encounters?: Array<{ id?: number }>;
        }>;
      };
    }>(
      accessToken,
      `
        query AttendanceZones($expansionId: Int) {
          worldData {
            zones(expansion_id: $expansionId) {
              name
              encounters {
                id
              }
            }
          }
        }
      `,
      { expansionId }
    );

    const zones = zonesPayload?.worldData?.zones ?? [];
    for (const zone of zones) {
      const zoneName = (zone.name ?? '').trim().toLowerCase();
      if (!MIDNIGHT_S1_RAID_NAMES.has(zoneName)) continue;

      for (const encounter of zone.encounters ?? []) {
        const encounterId = Number(encounter.id ?? 0);
        if (Number.isFinite(encounterId) && encounterId > 0) {
          encounterIds.add(Math.floor(encounterId));
        }
      }
    }

    if (encounterIds.size > 0) {
      break;
    }
  }

  midnightS1EncounterIdsCache = encounterIds;
  return encounterIds;
}

async function fetchFightParticipantsByCharId(
  accessToken: string,
  reportCode: string,
  ownership: AttendanceOwnershipData
): Promise<{
  totalBossKills: number;
  totalBossWipes: number;
  totalWipePulls: number;
  totalBossFights: number;
  bossesByCharId: Map<number, number>;
  bossKillsByCharId: Map<number, number>;
  deathStatsByCharId: Map<number, AttendanceDeathAggregate>;
  reportStartUtc: number | null;
  reportEndUtc: number | null;
}> {
  const metadata = await queryWcl<{
    reportData?: {
      report?: {
        startTime?: number;
        endTime?: number;
        fights?: WclFightRow[];
        masterData?: {
          actors?: WclActorRow[];
        };
      };
    };
  }>(
    accessToken,
    `
      query AttendanceReportMetadata($code: String!) {
        reportData {
          report(code: $code) {
            startTime
            endTime
            fights {
              id
              startTime
              endTime
              encounterID
              kill
            }
            masterData {
              actors(type: "Player") {
                id
                name
                server
              }
            }
          }
        }
      }
    `,
    { code: reportCode }
  );

  const report = metadata?.reportData?.report;
  if (!report) {
    throw new Error('Unable to load Warcraft Logs report metadata.');
  }

  const reportStartMs = Number(report.startTime ?? 0);
  const reportEndMs = Number(report.endTime ?? 0);
  const midnightS1EncounterIds = await getMidnightS1EncounterIds(accessToken);
  const fights = (report.fights ?? []).filter((fight) => {
    const fightId = Number(fight.id ?? 0);
    const encounterId = Number(fight.encounterID ?? 0);
    return Number.isFinite(fightId) && fightId > 0 && Number.isFinite(encounterId) && encounterId > 0;
  });
  if (fights.length === 0) {
    return {
      totalBossKills: 0,
      totalBossWipes: 0,
      totalWipePulls: 0,
      totalBossFights: 0,
      bossesByCharId: new Map(),
      bossKillsByCharId: new Map(),
      deathStatsByCharId: new Map(),
      reportStartUtc: reportStartMs > 0 ? Math.floor(reportStartMs / 1000) : null,
      reportEndUtc: reportEndMs > 0 ? Math.floor(reportEndMs / 1000) : null,
    };
  }

  const actorOwnerKeyById = new Map<number, string>();
  const actorCharIdById = new Map<number, number>();
  const reportOwnerKeys = new Set<string>();
  for (const actor of report.masterData?.actors ?? []) {
    const actorId = Number(actor.id ?? 0);
    const name = normalizeName(actor.name);
    const realmSlug = normalizeRealmSlug(actor.server);
    if (!actorId || !name) continue;

    const charId = ownership.charLookup.get(`${name}::${realmSlug}`) ?? ownership.nameOnlyLookup.get(name);
    if (!charId) continue;

    const ownerKey = ownership.ownerKeyByCharId.get(charId) ?? attendanceOwnerKey(null, charId);
    actorOwnerKeyById.set(actorId, ownerKey);
    actorCharIdById.set(actorId, charId);
    reportOwnerKeys.add(ownerKey);
  }

  const fightIds = new Set(fights.map((fight) => Number(fight.id)));
  const deathScopedFightIds = new Set(
    fights
      .filter((fight) => {
        const encounterId = Number(fight.encounterID ?? 0);
        if (!Number.isFinite(encounterId) || encounterId <= 0) return false;
        // Fail open: if raid encounter metadata is unavailable, count deaths for all boss encounters.
        if (midnightS1EncounterIds.size === 0) return true;
        return midnightS1EncounterIds.has(Math.floor(encounterId));
      })
      .map((fight) => Number(fight.id ?? 0))
      .filter((fightId) => Number.isFinite(fightId) && fightId > 0)
  );
  const encounterByFightId = new Map<number, number>(
    fights.map((fight) => [Number(fight.id), Number(fight.encounterID ?? 0)])
  );
  const attemptedEncounterIds = new Set<number>(
    fights.map((fight) => Number(fight.encounterID ?? 0)).filter((encounterId) => encounterId > 0)
  );
  const killEncounterIds = new Set<number>(
    fights
      .filter((fight) => fight.kill === true)
      .map((fight) => Number(fight.encounterID ?? 0))
      .filter((encounterId) => encounterId > 0)
  );
  const totalWipePulls = fights.filter((fight) => fight.kill !== true).length;
  const minFightStart = fights.reduce((min, fight) => Math.min(min, Number(fight.startTime ?? Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  const maxFightEnd = fights.reduce((max, fight) => Math.max(max, Number(fight.endTime ?? 0)), 0);

  const participantsByFight = new Map<number, Set<string>>();
  const participantsByFightChar = new Map<number, Set<number>>();
  let nextStart = Number.isFinite(minFightStart) ? minFightStart : 0;
  const absoluteEnd = Math.max(nextStart, maxFightEnd);

  while (nextStart <= absoluteEnd) {
    const page = await queryWcl<{
      reportData?: {
        report?: {
          events?: {
            data?: Array<{ type?: string; sourceID?: number; fight?: number }>;
            nextPageTimestamp?: number | null;
          };
        };
      };
    }>(
      accessToken,
      `
        query AttendanceCombatants($code: String!, $startTime: Float!, $endTime: Float!) {
          reportData {
            report(code: $code) {
              events(dataType: CombatantInfo, startTime: $startTime, endTime: $endTime) {
                data
                nextPageTimestamp
              }
            }
          }
        }
      `,
      {
        code: reportCode,
        startTime: nextStart,
        endTime: absoluteEnd,
      }
    );

    const events = page?.reportData?.report?.events?.data ?? [];
    for (const event of events) {
      if (String(event.type ?? '').toLowerCase() !== 'combatantinfo') continue;
      const fightId = Number(event.fight ?? 0);
      if (!fightIds.has(fightId)) continue;

      const sourceActorId = Number(event.sourceID ?? 0);
      const ownerKey = actorOwnerKeyById.get(sourceActorId);
      if (!ownerKey) continue;
      const sourceCharId = actorCharIdById.get(sourceActorId);
      if (!sourceCharId) continue;

      let fightSet = participantsByFight.get(fightId);
      if (!fightSet) {
        fightSet = new Set<string>();
        participantsByFight.set(fightId, fightSet);
      }
      fightSet.add(ownerKey);

      let fightCharSet = participantsByFightChar.get(fightId);
      if (!fightCharSet) {
        fightCharSet = new Set<number>();
        participantsByFightChar.set(fightId, fightCharSet);
      }
      fightCharSet.add(sourceCharId);
    }

    const nextPage = Number(page?.reportData?.report?.events?.nextPageTimestamp ?? 0);
    if (!Number.isFinite(nextPage) || nextPage <= 0 || nextPage <= nextStart) {
      break;
    }
    nextStart = nextPage;
  }

  nextStart = Number.isFinite(minFightStart) ? minFightStart : 0;
  const deathPositionByFight = new Map<number, number>();
  const deathStatsByCharIdMutable = new Map<number, AttendanceDeathAggregate>();

  while (nextStart <= absoluteEnd) {
    const page = await queryWcl<{
      reportData?: {
        report?: {
          events?: {
            data?: Array<{ targetID?: number; fight?: number }>;
            nextPageTimestamp?: number | null;
          };
        };
      };
    }>(
      accessToken,
      `
        query AttendanceDeaths($code: String!, $startTime: Float!, $endTime: Float!) {
          reportData {
            report(code: $code) {
              events(dataType: Deaths, startTime: $startTime, endTime: $endTime) {
                data
                nextPageTimestamp
              }
            }
          }
        }
      `,
      {
        code: reportCode,
        startTime: nextStart,
        endTime: absoluteEnd,
      }
    );

    const events = page?.reportData?.report?.events?.data ?? [];
    for (const event of events) {
      const fightId = Number(event.fight ?? 0);
      if (!deathScopedFightIds.has(fightId)) continue;

      const targetActorId = Number(event.targetID ?? 0);
      const targetCharId = actorCharIdById.get(targetActorId);
      if (!targetCharId) continue;

      const deathPosition = (deathPositionByFight.get(fightId) ?? 0) + 1;
      deathPositionByFight.set(fightId, deathPosition);

      // Ignore deaths after the first four in each fight for excessive-death scoring.
      if (deathPosition > 4) {
        continue;
      }

      const aggregate = deathStatsByCharIdMutable.get(targetCharId) ?? createAttendanceDeathAggregate();
      aggregate.totalDeaths += 1;

      if (deathPosition === 1) aggregate.firstDeathCount += 1;
      else if (deathPosition === 2) aggregate.secondDeathCount += 1;
      else if (deathPosition === 3) aggregate.thirdDeathCount += 1;
      else if (deathPosition === 4) aggregate.fourthDeathCount += 1;

      deathStatsByCharIdMutable.set(targetCharId, aggregate);
    }

    const nextPage = Number(page?.reportData?.report?.events?.nextPageTimestamp ?? 0);
    if (!Number.isFinite(nextPage) || nextPage <= 0 || nextPage <= nextStart) {
      break;
    }
    nextStart = nextPage;
  }

  const encounterParticipationByOwnerKey = new Map<string, Set<number>>();
  const killParticipationByOwnerKey = new Map<string, Set<number>>();
  for (const fightId of fightIds) {
    const participants = participantsByFight.get(fightId);
    if (!participants) continue;

    const encounterId = encounterByFightId.get(fightId);
    if (!encounterId || encounterId <= 0) continue;
    const isKillFight = killEncounterIds.has(encounterId);

    for (const ownerKey of participants) {
      let encounters = encounterParticipationByOwnerKey.get(ownerKey);
      if (!encounters) {
        encounters = new Set<number>();
        encounterParticipationByOwnerKey.set(ownerKey, encounters);
      }
      encounters.add(encounterId);

      if (isKillFight) {
        let killEncounters = killParticipationByOwnerKey.get(ownerKey);
        if (!killEncounters) {
          killEncounters = new Set<number>();
          killParticipationByOwnerKey.set(ownerKey, killEncounters);
        }
        killEncounters.add(encounterId);
      }
    }
  }

  for (const [fightId, participants] of participantsByFightChar.entries()) {
    if (!deathScopedFightIds.has(fightId)) continue;
    for (const blizzardCharId of participants) {
      const aggregate = deathStatsByCharIdMutable.get(blizzardCharId) ?? createAttendanceDeathAggregate();
      aggregate.fightsPresent += 1;
      deathStatsByCharIdMutable.set(blizzardCharId, aggregate);
    }
  }

  const firstAttemptedEncounterId = attemptedEncounterIds.values().next().value;
  const firstKillEncounterId = killEncounterIds.values().next().value;

  // Align with WCL attendance intent: if a mapped character appears in report actors,
  // treat them as minimally present when combatant events are incomplete.
  if (typeof firstAttemptedEncounterId === 'number' && firstAttemptedEncounterId > 0) {
    for (const ownerKey of reportOwnerKeys) {
      if (!encounterParticipationByOwnerKey.has(ownerKey)) {
        encounterParticipationByOwnerKey.set(ownerKey, new Set([firstAttemptedEncounterId]));
      }

      if (typeof firstKillEncounterId === 'number' && firstKillEncounterId > 0 && !killParticipationByOwnerKey.has(ownerKey)) {
        killParticipationByOwnerKey.set(ownerKey, new Set([firstKillEncounterId]));
      }
    }

  }

  const bossesByCharId = new Map<number, number>();
  for (const [ownerKey, encounters] of encounterParticipationByOwnerKey.entries()) {
    const ownedCharIds = ownership.charIdsByOwnerKey.get(ownerKey) ?? [];
    for (const blizzardCharId of ownedCharIds) {
      bossesByCharId.set(blizzardCharId, encounters.size);
    }
  }

  const bossKillsByCharId = new Map<number, number>();
  for (const [ownerKey, encounters] of killParticipationByOwnerKey.entries()) {
    const ownedCharIds = ownership.charIdsByOwnerKey.get(ownerKey) ?? [];
    for (const blizzardCharId of ownedCharIds) {
      bossKillsByCharId.set(blizzardCharId, encounters.size);
    }
  }

  const deathStatsByCharId = new Map<number, AttendanceDeathAggregate>();
  for (const [blizzardCharId, aggregate] of deathStatsByCharIdMutable.entries()) {
    deathStatsByCharId.set(blizzardCharId, {
      fightsPresent: aggregate.fightsPresent,
      totalDeaths: aggregate.totalDeaths,
      firstDeathCount: aggregate.firstDeathCount,
      secondDeathCount: aggregate.secondDeathCount,
      thirdDeathCount: aggregate.thirdDeathCount,
      fourthDeathCount: aggregate.fourthDeathCount,
    });
  }

  return {
    totalBossKills: killEncounterIds.size,
    totalBossWipes: Math.max(0, attemptedEncounterIds.size - killEncounterIds.size),
    totalWipePulls,
    totalBossFights: fights.length,
    bossesByCharId,
    bossKillsByCharId,
    deathStatsByCharId,
    reportStartUtc: reportStartMs > 0 ? Math.floor(reportStartMs / 1000) : null,
    reportEndUtc: reportEndMs > 0 ? Math.floor(reportEndMs / 1000) : null,
  };
}

async function upsertAttendanceReport(
  db: D1Database,
  occurrence: AttendanceOccurrence,
  payload: {
    reportCode: string | null;
    reportStartUtc: number | null;
    reportEndUtc: number | null;
    totalBossKills: number;
    totalBossWipes: number;
    totalWipePulls: number;
    totalBossFights: number;
    bossesByCharId: Map<number, number>;
    bossKillsByCharId: Map<number, number>;
    deathStatsByCharId: Map<number, AttendanceDeathAggregate>;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO raid_attendance_reports (
         raid_ref_key,
         raid_kind,
         primary_schedule_id,
         ad_hoc_raid_id,
         occurrence_start_utc,
         report_code,
         report_start_utc,
         report_end_utc,
         total_boss_kills,
         total_boss_wipes,
         total_wipe_pulls,
         total_boss_fights,
         synced_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
       ON CONFLICT(raid_ref_key, occurrence_start_utc) DO UPDATE SET
         report_code = excluded.report_code,
         report_start_utc = excluded.report_start_utc,
         report_end_utc = excluded.report_end_utc,
         total_boss_kills = excluded.total_boss_kills,
         total_boss_wipes = excluded.total_boss_wipes,
         total_wipe_pulls = excluded.total_wipe_pulls,
         total_boss_fights = excluded.total_boss_fights,
         synced_at = excluded.synced_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      occurrence.raid_ref_key,
      occurrence.raid_kind,
      occurrence.primary_schedule_id,
      occurrence.ad_hoc_raid_id,
      occurrence.occurrence_start_utc,
      payload.reportCode,
      payload.reportStartUtc,
      payload.reportEndUtc,
      Math.max(0, payload.totalBossKills),
      Math.max(0, payload.totalBossWipes),
      Math.max(0, payload.totalWipePulls),
      Math.max(0, payload.totalBossFights)
    )
    .run();

  const report = await db
    .prepare(
      `SELECT id
       FROM raid_attendance_reports
       WHERE raid_ref_key = ?
         AND occurrence_start_utc = ?
       LIMIT 1`
    )
    .bind(occurrence.raid_ref_key, occurrence.occurrence_start_utc)
    .first<{ id: number }>();

  const reportId = Number(report?.id ?? 0);
  if (!reportId) return;

  await db
    .prepare('DELETE FROM raid_attendance_participants WHERE report_id = ?')
    .bind(reportId)
    .run();

  await db
    .prepare('DELETE FROM raid_attendance_death_stats WHERE report_id = ?')
    .bind(reportId)
    .run();

  const inserts = [...payload.bossesByCharId.entries()].map(([blizzardCharId, bossesPresent]) =>
    db
      .prepare(
        `INSERT INTO raid_attendance_participants (
           report_id,
           blizzard_char_id,
           bosses_present,
           boss_kills_present,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`
      )
      .bind(
        reportId,
        blizzardCharId,
        Math.max(0, Math.floor(bossesPresent)),
        Math.max(0, Math.floor(payload.bossKillsByCharId.get(blizzardCharId) ?? 0))
      )
  );

  if (inserts.length > 0) {
    await db.batch(inserts);
  }

  const deathInserts = [...payload.deathStatsByCharId.entries()].map(([blizzardCharId, aggregate]) =>
    db
      .prepare(
        `INSERT INTO raid_attendance_death_stats (
           report_id,
           blizzard_char_id,
           fights_present,
           total_deaths,
           first_death_count,
           second_death_count,
           third_death_count,
           fourth_death_count,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`
      )
      .bind(
        reportId,
        blizzardCharId,
        Math.max(0, Math.floor(aggregate.fightsPresent)),
        Math.max(0, Math.floor(aggregate.totalDeaths)),
        Math.max(0, Math.floor(aggregate.firstDeathCount)),
        Math.max(0, Math.floor(aggregate.secondDeathCount)),
        Math.max(0, Math.floor(aggregate.thirdDeathCount)),
        Math.max(0, Math.floor(aggregate.fourthDeathCount))
      )
  );

  if (deathInserts.length > 0) {
    await db.batch(deathInserts);
  }

  await db
    .prepare('UPDATE raid_attendance_reports SET death_stats_synced_at = unixepoch() WHERE id = ?')
    .bind(reportId)
    .run();
}

async function syncAttendanceOccurrence(
  db: D1Database,
  accessToken: string,
  occurrence: AttendanceOccurrence,
  ownership: AttendanceOwnershipData
): Promise<void> {
  const candidates = await listCandidateReportsForOccurrence(
    accessToken,
    occurrence.occurrence_start_utc,
    occurrence.scheduled_duration_minutes
  );
  if (candidates.length === 0) {
    return;
  }

  for (const candidate of candidates.slice(0, 3)) {
    const details = await fetchFightParticipantsByCharId(accessToken, candidate.code, ownership);
    if ((details.totalBossKills + details.totalBossWipes) <= 0) continue;

    await upsertAttendanceReport(db, occurrence, {
      reportCode: candidate.code,
      reportStartUtc: details.reportStartUtc,
      reportEndUtc: details.reportEndUtc,
      totalBossKills: details.totalBossKills,
      totalBossWipes: details.totalBossWipes,
      totalWipePulls: details.totalWipePulls,
      totalBossFights: details.totalBossFights,
      bossesByCharId: details.bossesByCharId,
      bossKillsByCharId: details.bossKillsByCharId,
      deathStatsByCharId: details.deathStatsByCharId,
    });
    return;
  }

  await upsertAttendanceReport(db, occurrence, {
    reportCode: candidates[0]?.code ?? null,
    reportStartUtc: Math.floor(candidates[0].startTime / 1000),
    reportEndUtc: Math.floor(candidates[0].endTime / 1000),
    totalBossKills: 0,
    totalBossWipes: 0,
    totalWipePulls: 0,
    totalBossFights: 0,
    bossesByCharId: new Map(),
    bossKillsByCharId: new Map(),
    deathStatsByCharId: new Map(),
  });
}

export async function importAttendanceFromReportCode(
  dbInput: D1Database | undefined,
  occurrence: {
    raidKind: 'primary' | 'adhoc';
    primaryScheduleId: number | null;
    adHocRaidId: number | null;
    occurrenceStartUtc: number;
  },
  reportCode: string
): Promise<{ totalBossKills: number; participants: number }> {
  const db = getDatabase(dbInput);
  const now = nowInSeconds();
  const currentBackoffUntil = await getWclBackoffUntil(db);
  if (currentBackoffUntil && currentBackoffUntil > now) {
    throw new Error(`Warcraft Logs API backoff active until ${new Date(currentBackoffUntil * 1000).toISOString()}.`);
  }

  const code = reportCode.trim();
  if (!code) {
    throw new Error('Report code is required.');
  }

  const config = getWclAuthConfig();
  if (!config) {
    throw new Error('WCL credentials are not configured.');
  }

  const accessToken = await getWclAccessToken(config);
  if (!accessToken) {
    throw new Error('Failed to get WCL access token.');
  }

  const ownership = await loadAttendanceOwnership(db);

  let details: {
    totalBossKills: number;
    totalBossWipes: number;
    totalWipePulls: number;
    totalBossFights: number;
    bossesByCharId: Map<number, number>;
    bossKillsByCharId: Map<number, number>;
    deathStatsByCharId: Map<number, AttendanceDeathAggregate>;
    reportStartUtc: number | null;
    reportEndUtc: number | null;
  };
  try {
    details = await fetchFightParticipantsByCharId(accessToken, code, ownership);
    await clearWclBackoff(db);
  } catch (error) {
    if (error instanceof WclRateLimitError) {
      const backoffSeconds = Math.min(
        ATTENDANCE_WCL_MAX_BACKOFF_SECONDS,
        Math.max(ATTENDANCE_WCL_RATE_LIMIT_BACKOFF_SECONDS, error.retryAfterSeconds)
      );
      await setWclBackoffUntil(db, nowInSeconds() + backoffSeconds);
    }
    throw error;
  }

  const raidRefKey = toRaidRefKey(occurrence.raidKind, occurrence.primaryScheduleId, occurrence.adHocRaidId);

  await upsertAttendanceReport(
    db,
    {
      raid_ref_key: raidRefKey,
      raid_kind: occurrence.raidKind,
      primary_schedule_id: occurrence.primaryScheduleId,
      ad_hoc_raid_id: occurrence.adHocRaidId,
      occurrence_start_utc: occurrence.occurrenceStartUtc,
      scheduled_duration_minutes: 180,
    },
    {
      reportCode: code,
      reportStartUtc: details.reportStartUtc,
      reportEndUtc: details.reportEndUtc,
      totalBossKills: details.totalBossKills,
      totalBossWipes: details.totalBossWipes,
      totalWipePulls: details.totalWipePulls,
      totalBossFights: details.totalBossFights,
      bossesByCharId: details.bossesByCharId,
      bossKillsByCharId: details.bossKillsByCharId,
      deathStatsByCharId: details.deathStatsByCharId,
    }
  );

  return {
    totalBossKills: details.totalBossKills,
    participants: details.bossesByCharId.size,
  };
}

async function syncAttendanceFromWcl(db: D1Database): Promise<void> {
  const nowEpoch = nowInSeconds();
  const currentBackoffUntil = await getWclBackoffUntil(db);
  if (currentBackoffUntil && currentBackoffUntil > nowEpoch) {
    console.warn('[attendance] skipping sync during WCL backoff', {
      backoffUntil: currentBackoffUntil,
    });
    return;
  }

  const config = getWclAuthConfig();
  if (!config) return;

  const accessToken = await getWclAccessToken(config);
  if (!accessToken) return;

  const staleCutoff = nowEpoch - ATTENDANCE_SYNC_TTL_SECONDS;
  const zeroResultCutoff = nowEpoch - ATTENDANCE_ZERO_RESULT_RETRY_SECONDS;
  const occurrences = await listUnsignedRaidOccurrencesNeedingSync(db, staleCutoff, nowEpoch, zeroResultCutoff);
  if (occurrences.length === 0) return;

  const ownership = await loadAttendanceOwnership(db);

  let hitRateLimit = false;
  for (const occurrence of occurrences) {
    try {
      await syncAttendanceOccurrence(db, accessToken, occurrence, ownership);
    } catch (error) {
      if (error instanceof WclRateLimitError) {
        const backoffSeconds = Math.min(
          ATTENDANCE_WCL_MAX_BACKOFF_SECONDS,
          Math.max(ATTENDANCE_WCL_RATE_LIMIT_BACKOFF_SECONDS, error.retryAfterSeconds)
        );
        const untilEpoch = nowInSeconds() + backoffSeconds;
        await setWclBackoffUntil(db, untilEpoch);
        hitRateLimit = true;
        console.warn('[attendance] WCL rate limit reached, pausing sync', {
          backoffSeconds,
          backoffUntil: untilEpoch,
        });
        break;
      }

      // Keep attendance scoring resilient if one report fails to parse.
      console.warn('[attendance] failed to sync occurrence', {
        raidRefKey: occurrence.raid_ref_key,
        occurrenceStartUtc: occurrence.occurrence_start_utc,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!hitRateLimit) {
    await clearWclBackoff(db);
  }
}

function buildScoreForRaid(options: {
  signupStatus: AttendanceSignupStatus;
  bossesPresent: number;
  participationBossesPresent: number;
  totalBosses: number;
  isBench: boolean;
  canApplyNoShowPenalty: boolean;
}): { pointsEarned: number; pointsPossible: number; benchBonusPoints: number } {
  const totalBosses = Math.max(0, options.totalBosses);
  if (totalBosses <= 0) {
    return { pointsEarned: 0, pointsPossible: 0, benchBonusPoints: 0 };
  }

  if (options.isBench) {
    return {
      pointsEarned: ATTENDANCE_BASE_POINTS + ATTENDANCE_BENCH_BONUS_POINTS,
      pointsPossible: ATTENDANCE_BASE_POINTS,
      benchBonusPoints: ATTENDANCE_BENCH_BONUS_POINTS,
    };
  }

  if (options.signupStatus === 'coming' && options.participationBossesPresent <= 0 && options.canApplyNoShowPenalty) {
    return {
      pointsEarned: -ATTENDANCE_COMING_NO_SHOW_PENALTY_POINTS,
      pointsPossible: ATTENDANCE_BASE_POINTS,
      benchBonusPoints: 0,
    };
  }

  const ratio = Math.max(0, Math.min(1, options.bossesPresent / totalBosses));
  const weight = options.signupStatus === 'unsigned'
    ? ATTENDANCE_UNSIGNED_WEIGHT
    : ATTENDANCE_STATUS_WEIGHT[options.signupStatus];

  const pointsEarned = ATTENDANCE_BASE_POINTS * weight * ratio;
  return {
    pointsEarned,
    pointsPossible: ATTENDANCE_BASE_POINTS,
    benchBonusPoints: 0,
  };
}

function roundupOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function reportTotalBosses(report: Pick<AttendanceReportRow, 'total_boss_kills' | 'total_boss_wipes'>): number {
  return Math.max(0, report.total_boss_kills) + Math.max(0, report.total_boss_wipes ?? 0);
}

function reportScorableBosses(report: Pick<AttendanceReportRow, 'total_boss_kills'>): number {
  return Math.max(0, report.total_boss_kills);
}

function attendanceRaidNightKey(raidRefKey: string, occurrenceStartUtc: number): string {
  return `${raidRefKey}|${attendanceNightFormatter.format(new Date(occurrenceStartUtc * 1000))}`;
}

function chooseCanonicalNightReport(existing: AttendanceReportRow, candidate: AttendanceReportRow): AttendanceReportRow {
  const existingHasCode = Boolean((existing.report_code ?? '').trim());
  const candidateHasCode = Boolean((candidate.report_code ?? '').trim());

  if (candidateHasCode !== existingHasCode) {
    return candidateHasCode ? candidate : existing;
  }

  const existingTotalBosses = reportTotalBosses(existing);
  const candidateTotalBosses = reportTotalBosses(candidate);
  if (candidateTotalBosses !== existingTotalBosses) {
    return candidateTotalBosses > existingTotalBosses ? candidate : existing;
  }

  if (candidate.occurrence_start_utc !== existing.occurrence_start_utc) {
    return candidate.occurrence_start_utc < existing.occurrence_start_utc ? candidate : existing;
  }

  return candidate.id < existing.id ? candidate : existing;
}

function signupStatusRank(status: AttendanceSignupStatus): number {
  if (status === 'coming') return 4;
  if (status === 'tentative') return 3;
  if (status === 'late') return 2;
  if (status === 'absent') return 1;
  return 0;
}

export async function getAttendanceSummaryMap(
  dbInput?: D1Database,
  options?: { includeBreakdownFor?: number[] }
): Promise<Map<number, AttendanceSummary>> {
  const db = getDatabase(dbInput);

  try {
    await syncAttendanceFromWcl(db);
  } catch (error) {
    // Best effort sync only. Existing cached attendance remains usable.
    console.warn('[attendance] sync failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const includeBreakdownFor = new Set((options?.includeBreakdownFor ?? []).filter((id) => Number.isFinite(id) && id > 0));
  const ownership = await loadAttendanceOwnership(db);

  const [reportsResult, participantsResult, signupsResult, overridesResult, rosterTeamMembersResult] = await Promise.all([
    db
      .prepare(
        `SELECT
           id,
           raid_ref_key,
           raid_kind,
           primary_schedule_id,
           ad_hoc_raid_id,
           occurrence_start_utc,
           report_code,
           total_boss_kills,
           total_boss_wipes,
           total_wipe_pulls
         FROM raid_attendance_reports
         WHERE occurrence_start_utc >= ?
           AND raid_kind = 'primary'
           AND (total_boss_kills + COALESCE(total_boss_wipes, 0)) > 0`
      )
      .bind(ATTENDANCE_SCORING_START_UTC)
      .all<AttendanceReportRow>(),
    db
      .prepare(
        `SELECT
           p.report_id,
           p.blizzard_char_id,
           p.bosses_present,
           p.boss_kills_present
         FROM raid_attendance_participants p
         JOIN raid_attendance_reports r ON r.id = p.report_id
         WHERE r.occurrence_start_utc >= ?
           AND r.raid_kind = 'primary'
           AND (r.total_boss_kills + COALESCE(r.total_boss_wipes, 0)) > 0`
      )
      .bind(ATTENDANCE_SCORING_START_UTC)
      .all<AttendanceParticipantRow>(),
    db
      .prepare(
        `SELECT
           'primary:' || CAST(rs.primary_schedule_id AS TEXT) AS raid_ref_key,
           rs.occurrence_start_utc,
           c.blizzard_char_id,
           rs.signup_status
         FROM raid_signups rs
         JOIN characters c ON c.id = rs.character_id
         WHERE rs.raid_kind = 'primary'
           AND rs.occurrence_start_utc IS NOT NULL
           AND rs.occurrence_start_utc >= ?`
      )
      .bind(ATTENDANCE_SCORING_START_UTC)
      .all<AttendanceSignupRow>(),
    db
      .prepare(
        `SELECT
           raid_ref_key,
           occurrence_start_utc,
           blizzard_char_id
         FROM raid_attendance_overrides
         WHERE occurrence_start_utc >= ?
           AND raid_kind = 'primary'
           AND override_kind = 'bench'`
      )
      .bind(ATTENDANCE_SCORING_START_UTC)
      .all<AttendanceOverrideRow>(),
    db
      .prepare(
        `SELECT
           rtm.blizzard_char_id,
           MIN(rtm.created_at) AS joined_at_utc
         FROM raid_team_members rtm
         JOIN raid_teams rt ON rt.id = rtm.team_id
         WHERE rt.is_archived = 0
         GROUP BY rtm.blizzard_char_id`
      )
      .all<AttendanceRosterTeamMemberRow>(),
  ]);

  const targetCharIds = [...new Set([
    ...ownership.raiderCharIds,
    ...[...includeBreakdownFor],
  ].filter((id) => Number.isFinite(id) && id > 0))];

  const reports = reportsResult.results ?? [];
  const canonicalByNightKey = new Map<string, AttendanceReportRow>();
  for (const report of reports) {
    const nightKey = attendanceRaidNightKey(report.raid_ref_key, report.occurrence_start_utc);
    const existing = canonicalByNightKey.get(nightKey);
    if (!existing) {
      canonicalByNightKey.set(nightKey, report);
      continue;
    }

    canonicalByNightKey.set(nightKey, chooseCanonicalNightReport(existing, report));
  }

  const canonicalReportByOriginalId = new Map<number, AttendanceReportRow>();
  for (const report of reports) {
    const nightKey = attendanceRaidNightKey(report.raid_ref_key, report.occurrence_start_utc);
    const canonical = canonicalByNightKey.get(nightKey);
    if (canonical) {
      canonicalReportByOriginalId.set(report.id, canonical);
    }
  }

  const reportsById = new Map<number, AttendanceReportRow>(
    [...canonicalByNightKey.values()].map((row) => [row.id, row])
  );
  const reportKeyByRaid = new Map<string, AttendanceReportRow>();
  for (const report of reports) {
    const canonical = canonicalReportByOriginalId.get(report.id) ?? report;
    reportKeyByRaid.set(`${report.raid_ref_key}|${report.occurrence_start_utc}`, canonical);
  }

  const participantsByReportAndOwner = new Map<string, number>();
  const bossKillsPresentByReportAndOwner = new Map<string, number>();
  const participantRowsByReport = new Map<number, number>();
  for (const row of participantsResult.results ?? []) {
    const canonical = canonicalReportByOriginalId.get(row.report_id);
    if (!canonical) continue;

    participantRowsByReport.set(canonical.id, (participantRowsByReport.get(canonical.id) ?? 0) + 1);

    const ownerKey = ownership.ownerKeyByCharId.get(row.blizzard_char_id) ?? attendanceOwnerKey(null, row.blizzard_char_id);
    const key = `${canonical.id}|${ownerKey}`;
    const bossesPresent = Math.max(0, Math.floor(row.bosses_present));
    const existing = participantsByReportAndOwner.get(key) ?? 0;
    participantsByReportAndOwner.set(key, existing + bossesPresent);

    const bossKillsPresent = Math.max(0, Math.floor(row.boss_kills_present ?? 0));
    const existingKillsPresent = bossKillsPresentByReportAndOwner.get(key) ?? 0;
    bossKillsPresentByReportAndOwner.set(key, existingKillsPresent + bossKillsPresent);
  }

  const signupByRaidAndOwner = new Map<string, AttendanceSignupStatus>();
  for (const row of signupsResult.results ?? []) {
    const report = reportKeyByRaid.get(`${row.raid_ref_key}|${row.occurrence_start_utc}`);
    if (!report) continue;

    const status = row.signup_status;
    if (status !== 'coming' && status !== 'tentative' && status !== 'late' && status !== 'absent') continue;

    const ownerKey = ownership.ownerKeyByCharId.get(row.blizzard_char_id) ?? attendanceOwnerKey(null, row.blizzard_char_id);
    const key = `${report.id}|${ownerKey}`;
    const existing = signupByRaidAndOwner.get(key) ?? 'unsigned';
    if (signupStatusRank(status) >= signupStatusRank(existing)) {
      signupByRaidAndOwner.set(key, status);
    }
  }

  const benchByRaidAndOwner = new Set<string>();
  for (const row of overridesResult.results ?? []) {
    const report = reportKeyByRaid.get(`${row.raid_ref_key}|${row.occurrence_start_utc}`);
    if (!report) continue;
    const ownerKey = ownership.ownerKeyByCharId.get(row.blizzard_char_id) ?? attendanceOwnerKey(null, row.blizzard_char_id);
    benchByRaidAndOwner.add(`${report.id}|${ownerKey}`);
  }

  const rosterJoinByCharId = new Map<number, number>();
  for (const row of rosterTeamMembersResult.results ?? []) {
    const blizzardCharId = Number(row.blizzard_char_id);
    const joinedAtUtc = Number(row.joined_at_utc);
    if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) continue;
    if (!Number.isInteger(joinedAtUtc) || joinedAtUtc <= 0) continue;
    rosterJoinByCharId.set(blizzardCharId, joinedAtUtc);
  }

  const attendanceStartByOwnerKey = new Map<string, number>();
  for (const [ownerKey, ownerCharIds] of ownership.charIdsByOwnerKey.entries()) {
    let ownerJoinStartUtc: number | null = null;
    for (const blizzardCharId of ownerCharIds) {
      const joinStartUtc = rosterJoinByCharId.get(blizzardCharId);
      if (!Number.isInteger(joinStartUtc) || (joinStartUtc ?? 0) <= 0) continue;
      if (ownerJoinStartUtc === null || joinStartUtc < ownerJoinStartUtc) {
        ownerJoinStartUtc = joinStartUtc;
      }
    }

    if (ownerJoinStartUtc !== null) {
      attendanceStartByOwnerKey.set(ownerKey, Math.max(ATTENDANCE_SCORING_START_UTC, ownerJoinStartUtc));
    }
  }

  const summaryMap = new Map<number, AttendanceSummary>();
  const targetOwnerKeys = [...new Set(targetCharIds.map((blizzardCharId) => ownership.ownerKeyByCharId.get(blizzardCharId) ?? attendanceOwnerKey(null, blizzardCharId)))];
  const includeBreakdownForOwners = new Set([...includeBreakdownFor].map((blizzardCharId) => ownership.ownerKeyByCharId.get(blizzardCharId) ?? attendanceOwnerKey(null, blizzardCharId)));

  for (const ownerKey of targetOwnerKeys) {
    let pointsEarnedTotal = 0;
    let pointsPossibleTotal = 0;
    let benchBonusTotal = 0;
    let scoredRaidCount = 0;
    const breakdown: AttendanceRaidBreakdown[] = [];
    const ownerAttendanceStartUtc = attendanceStartByOwnerKey.get(ownerKey) ?? ATTENDANCE_SCORING_START_UTC;

    for (const report of reportsById.values()) {
      if (report.occurrence_start_utc < ownerAttendanceStartUtc) continue;

      const lookupKey = `${report.id}|${ownerKey}`;
      const totalBosses = reportScorableBosses(report);
      const participationTotalBosses = reportTotalBosses(report);
      const bossesPresent = Math.min(participationTotalBosses, Math.max(0, Math.floor(participantsByReportAndOwner.get(lookupKey) ?? 0)));
      const bossKillsPresent = Math.min(Math.max(0, report.total_boss_kills), Math.max(0, Math.floor(bossKillsPresentByReportAndOwner.get(lookupKey) ?? 0)));
      const signupStatus = signupByRaidAndOwner.get(lookupKey) ?? 'unsigned';
      const isBench = benchByRaidAndOwner.has(lookupKey);
      const canApplyNoShowPenalty = (participantRowsByReport.get(report.id) ?? 0) > 0;

      const score = buildScoreForRaid({
        signupStatus,
        bossesPresent: bossKillsPresent,
        participationBossesPresent: bossesPresent,
        totalBosses,
        isBench,
        canApplyNoShowPenalty,
      });

      if (score.pointsPossible <= 0) continue;

      scoredRaidCount += 1;
      pointsEarnedTotal += score.pointsEarned;
      pointsPossibleTotal += score.pointsPossible;
      benchBonusTotal += score.benchBonusPoints;

      if (includeBreakdownForOwners.has(ownerKey)) {
        breakdown.push({
          raidRefKey: report.raid_ref_key,
          raidKind: report.raid_kind,
          primaryScheduleId: report.primary_schedule_id,
          adHocRaidId: report.ad_hoc_raid_id,
          occurrenceStartUtc: report.occurrence_start_utc,
          bossKillsPresent,
          bossKills: Math.max(0, report.total_boss_kills),
          bossWipes: Math.max(0, report.total_wipe_pulls ?? 0),
          totalBosses,
          bossesPresent: bossKillsPresent,
          bossesMissed: Math.max(0, totalBosses - bossKillsPresent),
          signupStatus,
          isBench,
          pointsEarned: roundupOneDecimal(score.pointsEarned),
          pointsPossible: score.pointsPossible,
          benchBonusPoints: score.benchBonusPoints,
        });
      }
    }

    breakdown.sort((a, b) => b.occurrenceStartUtc - a.occurrenceStartUtc);

    const scorePercent = pointsPossibleTotal > 0
      ? roundupOneDecimal((pointsEarnedTotal / pointsPossibleTotal) * 100)
      : 0;

    const summary: AttendanceSummary = {
      scorePercent,
      totalPointsEarned: roundupOneDecimal(pointsEarnedTotal),
      totalPointsPossible: roundupOneDecimal(pointsPossibleTotal),
      totalBenchBonusPoints: roundupOneDecimal(benchBonusTotal),
      scoredRaidCount,
      breakdown,
    };

    for (const blizzardCharId of ownership.charIdsByOwnerKey.get(ownerKey) ?? []) {
      summaryMap.set(blizzardCharId, summary);
    }
  }

  return summaryMap;
}

export async function refreshAttendanceCache(dbInput?: D1Database): Promise<void> {
  const db = getDatabase(dbInput);
  await syncAttendanceFromWcl(db);
}

export function attendanceStatusLabel(status: AttendanceSignupStatus): string {
  if (status === 'coming') return 'Signed Up';
  if (status === 'tentative') return 'Tentative';
  if (status === 'late') return 'Late';
  if (status === 'absent') return 'Absent';
  return 'No Signup';
}

export function attendanceScoringStartUtc(): number {
  return ATTENDANCE_SCORING_START_UTC;
}
