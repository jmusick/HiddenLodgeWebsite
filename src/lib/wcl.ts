import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';

// Shared Warcraft Logs client: OAuth token, GraphQL helper, rate-limit backoff,
// WCL-actor -> roster-character matching, and per-report fight/death stats.

interface CharacterRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  user_id: number | null;
}

interface RaiderLookupRow {
  blizzard_char_id: number;
  name: string;
  realm_slug: string;
}

export interface WclCharacterLookup {
  raiderCharIds: number[];
  charLookup: Map<string, number>;
  nameOnlyLookup: Map<string, number>;
  ownerKeyByCharId: Map<number, string>;
  charIdsByOwnerKey: Map<string, number[]>;
}

export interface WclDeathAggregate {
  fightsPresent: number;
  totalDeaths: number;
  firstDeathCount: number;
  secondDeathCount: number;
  thirdDeathCount: number;
  fourthDeathCount: number;
}

export interface WclAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface WclFightRow {
  id: number;
  startTime: number;
  endTime: number;
  encounterID?: number;
  difficulty?: number;
  kill?: boolean;
}

interface WclActorRow {
  id: number;
  name?: string;
  server?: string;
  gameID?: number;
}

// Historical site_settings key name; shared by every WCL consumer.
const WCL_BACKOFF_KEY = 'attendance_wcl_backoff_until';
const WCL_RATE_LIMIT_BACKOFF_SECONDS = 15 * 60;
const WCL_MAX_BACKOFF_SECONDS = 2 * 60 * 60;

const WCL_OAUTH_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_GRAPHQL_URL = 'https://www.warcraftlogs.com/api/v2/client';
/**
 * Per-request cap, matching blizzard-fetch.ts / raider-io.ts. These calls run
 * inside cron requests with a 30s external timeout, so a hung WCL response must
 * fail fast rather than stall the whole tick.
 */
const WCL_REQUEST_TIMEOUT_MS = 8_000;

let wclTokenCache: { accessToken: string; expiresAt: number } | null = null;

export class WclRateLimitError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Warcraft Logs API rate limit reached (429).');
    this.name = 'WclRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

export async function getWclBackoffUntil(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM site_settings WHERE key = ? LIMIT 1`)
    .bind(WCL_BACKOFF_KEY)
    .first<{ value: string | null }>();

  const parsed = Number.parseInt((row?.value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function setWclBackoffUntil(db: D1Database, untilEpoch: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(WCL_BACKOFF_KEY, String(untilEpoch))
    .run();
}

export async function applyWclRateLimitBackoff(db: D1Database, error: WclRateLimitError): Promise<void> {
  const seconds = Math.min(WCL_MAX_BACKOFF_SECONDS, Math.max(WCL_RATE_LIMIT_BACKOFF_SECONDS, error.retryAfterSeconds));
  await setWclBackoffUntil(db, Math.floor(Date.now() / 1000) + seconds);
}

export async function clearWclBackoff(db: D1Database): Promise<void> {
  await db
    .prepare(`DELETE FROM site_settings WHERE key = ?`)
    .bind(WCL_BACKOFF_KEY)
    .run();
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function normalizeRealmSlug(realm: string | null | undefined): string {
  return (realm ?? '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/([a-z])([0-9])/g, '$1-$2')
    .replace(/([0-9])([a-z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function createDeathAggregate(): WclDeathAggregate {
  return {
    fightsPresent: 0,
    totalDeaths: 0,
    firstDeathCount: 0,
    secondDeathCount: 0,
    thirdDeathCount: 0,
    fourthDeathCount: 0,
  };
}

export function characterOwnerKey(userId: number | null | undefined, blizzardCharId: number): string {
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

export async function loadWclCharacterLookup(db: D1Database): Promise<WclCharacterLookup> {
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
      .all<CharacterRow>(),
    db
      .prepare(
        `SELECT
           blizzard_char_id,
           name,
           realm_slug
         FROM raider_metrics_cache`
      )
      .all<RaiderLookupRow>(),
  ]);

  const charLookup = new Map<string, number>();
  const nameOnlyLookupMutable = new Map<string, number | null>();
  const ownerKeyByCharId = new Map<number, string>();
  const charIdsByOwnerKeyMutable = new Map<string, Set<number>>();

  for (const row of characterRowsResult.results ?? []) {
    const blizzardCharId = Number(row.blizzard_char_id);
    if (!Number.isInteger(blizzardCharId) || blizzardCharId <= 0) continue;

    const ownerKey = characterOwnerKey(row.user_id, blizzardCharId);
    ownerKeyByCharId.set(blizzardCharId, ownerKey);
    addCharIdToOwnerMap(charIdsByOwnerKeyMutable, ownerKey, blizzardCharId);

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

    const existingOwnerKey = ownerKeyByCharId.get(blizzardCharId) ?? characterOwnerKey(null, blizzardCharId);
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

/**
 * Matches a WCL player actor to a roster/character blizzard_char_id. WCL's
 * `gameID` is the Blizzard character id, so it wins whenever it's a character
 * we know; name + server is only the fallback. Name matching alone is ambiguous
 * when a deleted character's name was reused (same name + realm, two ids).
 */
export function matchWclActorCharId(
  actor: { name?: string | null; server?: string | null; gameID?: number | null },
  ownership: WclCharacterLookup
): number | null {
  const gameId = Number(actor.gameID ?? 0);
  if (Number.isInteger(gameId) && gameId > 0 && ownership.ownerKeyByCharId.has(gameId)) return gameId;
  const name = normalizeName(actor.name);
  if (!name) return null;
  return ownership.charLookup.get(`${name}::${normalizeRealmSlug(actor.server)}`) ?? ownership.nameOnlyLookup.get(name) ?? null;
}

export function getWclAuthConfig(): WclAuthConfig | null {
  const clientId = (env.WCL_CLIENT_ID ?? '').trim();
  const clientSecret = (env.WCL_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function getWclAccessToken(config: WclAuthConfig): Promise<string | null> {
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
    signal: AbortSignal.timeout(WCL_REQUEST_TIMEOUT_MS),
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

export async function queryWcl<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const response = await fetch(WCL_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(WCL_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After')) ?? WCL_RATE_LIMIT_BACKOFF_SECONDS;
      throw new WclRateLimitError(retryAfterSeconds);
    }
    return null;
  }
  const payload = (await response.json()) as { data?: T; errors?: unknown[] };
  if ((payload.errors?.length ?? 0) > 0) return null;
  return payload.data ?? null;
}

export async function fetchReportFightStats(
  accessToken: string,
  reportCode: string,
  ownership: WclCharacterLookup,
  deathFightFilter: (fight: WclFightRow) => boolean
): Promise<{
  totalBossKills: number;
  totalBossWipes: number;
  totalWipePulls: number;
  totalBossFights: number;
  scopedFightCount: number;
  scopedKillCount: number;
  bossesByCharId: Map<number, number>;
  bossKillsByCharId: Map<number, number>;
  deathStatsByCharId: Map<number, WclDeathAggregate>;
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
      query WclReportMetadata($code: String!) {
        reportData {
          report(code: $code) {
            startTime
            endTime
            fights {
              id
              startTime
              endTime
              encounterID
              difficulty
              kill
            }
            masterData {
              actors(type: "Player") {
                id
                name
                server
                gameID
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
      scopedFightCount: 0,
      scopedKillCount: 0,
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

    const charId = matchWclActorCharId(actor, ownership);
    if (!charId) {
      const nameOnlyResult = ownership.nameOnlyLookup.get(name);
      const reason = nameOnlyResult === null ? 'duplicate name, realm slug mismatch' : 'not found in character lookup';
      console.warn('[wcl] WCL actor not matched to any character', {
        reportCode,
        actorName: actor.name,
        actorServer: actor.server,
        normalizedKey: `${name}::${realmSlug}`,
        reason,
      });
      continue;
    }

    const ownerKey = ownership.ownerKeyByCharId.get(charId) ?? characterOwnerKey(null, charId);
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
        return deathFightFilter(fight);
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
        query WclCombatants($code: String!, $startTime: Float!, $endTime: Float!) {
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
  const deathStatsByCharIdMutable = new Map<number, WclDeathAggregate>();

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
        query WclDeaths($code: String!, $startTime: Float!, $endTime: Float!) {
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

      const aggregate = deathStatsByCharIdMutable.get(targetCharId) ?? createDeathAggregate();
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
      const aggregate = deathStatsByCharIdMutable.get(blizzardCharId) ?? createDeathAggregate();
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

  const deathStatsByCharId = new Map<number, WclDeathAggregate>();
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
    scopedFightCount: deathScopedFightIds.size,
    scopedKillCount: fights.filter((fight) => fight.kill === true && deathScopedFightIds.has(Number(fight.id))).length,
    bossesByCharId,
    bossKillsByCharId,
    deathStatsByCharId,
    reportStartUtc: reportStartMs > 0 ? Math.floor(reportStartMs / 1000) : null,
    reportEndUtc: reportEndMs > 0 ? Math.floor(reportEndMs / 1000) : null,
  };
}
