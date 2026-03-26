import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { fallbackClassIconUrl, loadBlizzardClassIconMap, normalizeWowClassName } from './class-icons';
import { getBlizzardAppAccessToken } from './blizzard-app-token';
import { fetchBlizzardJsonWithRetry } from './blizzard-fetch';

const GUILD_REALM_SLUG = 'illidan';
const GUILD_NAME_SLUG = 'hidden-lodge';
const REGION = 'us';
const SUMMARY_TTL_SECONDS = 15 * 60;
const DETAILS_TTL_SECONDS = 24 * 60 * 60;
const DETAIL_BATCH_SIZE = 8;
const QUEST_BACKFILL_BATCH_SIZE = 24;
const API_BASE = `https://${REGION}.api.blizzard.com`;
const STATIC_NAMESPACE = `static-${REGION}`;
const LOCALE = 'en_US';

// The guild roster API returns only { key, id } in playable_class — name is absent.
// This map lets us resolve a display name from the numeric class ID.
const WOW_CLASS_NAMES_BY_ID: Record<number, string> = {
  1: 'Warrior',
  2: 'Paladin',
  3: 'Hunter',
  4: 'Rogue',
  5: 'Priest',
  6: 'Death Knight',
  7: 'Shaman',
  8: 'Mage',
  9: 'Warlock',
  10: 'Monk',
  11: 'Druid',
  12: 'Demon Hunter',
  13: 'Evoker',
};

function resolveClassName(playableClass?: { name?: string; id?: number }): string {
  return playableClass?.name ?? WOW_CLASS_NAMES_BY_ID[playableClass?.id ?? -1] ?? 'Unknown';
}

function resolveRaceName(playableRace?: { name?: string }): string {
  return playableRace?.name ?? 'Unknown';
}

interface GuildRosterMember {
  character: {
    key?: { href?: string };
    id: number;
    name: string;
    realm: { slug: string; name?: string };
    level?: number;
    playable_class?: { name?: string; id?: number };
    playable_race?: { name?: string };
  };
  rank: number;
}

interface CharacterProfileResponse {
  realm?: { name?: string };
  character_class?: { name?: string };
  playable_class?: { name?: string };
  race?: { name?: string };
  playable_race?: { name?: string };
  level?: number;
  achievement_points?: number;
}

interface CharacterMountsResponse {
  mounts?: unknown[];
}

interface CharacterPetsResponse {
  pets?: Array<{ species?: { id?: number } }>;
}

interface CharacterToysResponse {
  toys?: unknown[];
}

const rosterColumnState: Record<string, boolean | null> = {
  quest_count: null,
  quest_count_checked: null,
  deaths_count: null,
  deaths_checked: null,
  critter_count: null,
  critter_checked: null,
};

interface CacheRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  realm_slug: string;
  class_name: string;
  race_name: string;
  level: number;
  rank: number;
  achievement_points: number;
  quest_count: number;
  deaths_count: number;
  critter_count: number;
  mount_count: number;
  pet_count: number;
  toy_count: number;
  details_synced_at: number | null;
}

export interface CachedRosterMember {
  blizzardCharId: number;
  name: string;
  realm: string;
  realmSlug: string;
  className: string;
  raceName: string;
  level: number;
  rank: number;
  achievementPoints: number;
  questCount: number;
  deathsCount: number;
  critterCount: number;
  mountCount: number;
  petCount: number;
  toyCount: number;
  detailsSyncedAt: number | null;
  classIconUrl: string | null;
}

export interface RosterCacheStatus {
  lastSummarySync: number | null;
  lastDetailSync: number | null;
  pendingDetailCount: number;
}

export interface RosterRefreshOptions {
  batchSize?: number;
  questBackfillBatchSize?: number;
}

export interface RosterRefreshDiagnostics {
  totalMembers: number;
  detailCandidatesSelected: number;
  detailProcessed: number;
  detailSkipped: number;
  detailFailed: number;
  detailPartial: number;
  questBackfillSelected: number;
  questBackfillProcessed: number;
  deathsBackfillSelected: number;
  deathsBackfillProcessed: number;
  critterBackfillSelected: number;
  critterBackfillProcessed: number;
  profileFetchFailed: number;
  statisticsFetchFailed: number;
  mountsFetchFailed: number;
  petsFetchFailed: number;
  toysFetchFailed: number;
}

export interface RosterRefreshResult {
  status: RosterCacheStatus;
  diagnostics: RosterRefreshDiagnostics;
}

function formatRealmFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getRosterRefreshOptions(overrides?: RosterRefreshOptions): Required<RosterRefreshOptions> {
  return {
    batchSize:
      overrides?.batchSize ??
      parsePositiveInteger(env.ROSTER_DETAIL_BATCH_SIZE, DETAIL_BATCH_SIZE),
    questBackfillBatchSize:
      overrides?.questBackfillBatchSize ??
      parsePositiveInteger(env.ROSTER_BACKFILL_BATCH_SIZE, QUEST_BACKFILL_BATCH_SIZE),
  };
}

function getDatabase(db?: D1Database): D1Database {
  return db ?? env.DB;
}

async function hasRosterColumn(db: D1Database, columnName: keyof typeof rosterColumnState): Promise<boolean> {
  const cachedState = rosterColumnState[columnName];
  if (cachedState === true) {
    return cachedState;
  }

  try {
    const pragma = await db.prepare('PRAGMA table_info(roster_members_cache)').all<{ name: string }>();
    const columns = (pragma.results ?? []) as Array<{ name?: string }>;
    rosterColumnState[columnName] = columns.some((column) => column.name === columnName);
  } catch {
    if (cachedState === null) {
      rosterColumnState[columnName] = false;
    }
  }

  return rosterColumnState[columnName] ?? false;
}

async function hasQuestCountColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'quest_count');
}

async function hasQuestCountCheckedColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'quest_count_checked');
}

async function hasDeathsCountColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'deaths_count');
}

async function hasDeathsCountCheckedColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'deaths_checked');
}

async function hasCritterCountColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'critter_count');
}

async function hasCritterCountCheckedColumn(db: D1Database): Promise<boolean> {
  return hasRosterColumn(db, 'critter_checked');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOptionalBlizzardJson<T>(url: string, accessToken: string): Promise<T | null> {
  try {
    return await fetchBlizzardJsonWithRetry<T>(url, accessToken);
  } catch {
    return null;
  }
}

function extractStatisticCount(
  statsPayload: any,
  directKeys: string[],
  matcher: (name: string, type: string, node: any) => boolean
): number {
  if (!statsPayload || typeof statsPayload !== 'object') return 0;

  for (const key of directKeys) {
    const direct = Number(statsPayload[key] ?? NaN);
    if (Number.isFinite(direct) && direct >= 0) {
      return direct;
    }
  }

  const visit = (node: any): number | null => {
    if (!node || typeof node !== 'object') return null;

    const name = String(node.name ?? node.description ?? node.display_string ?? '').toLowerCase();
    const type = String(node.type ?? node.key ?? node.statistic?.type ?? '').toLowerCase();
    const quantity = Number(
      node.quantity ??
        node.value ??
        node.count ??
        node.total ??
        node.statistic?.quantity ??
        node.statistic?.value ??
        NaN
    );
    if (Number.isFinite(quantity) && quantity >= 0 && matcher(name, type, node)) {
      return quantity;
    }

    for (const value of Object.values(node)) {
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = visit(entry);
          if (found !== null) return found;
        }
      } else if (typeof value === 'object') {
        const found = visit(value);
        if (found !== null) return found;
      }
    }

    return null;
  };

  return visit(statsPayload) ?? 0;
}

function extractQuestCount(statsPayload: any): number {
  return extractStatisticCount(
    statsPayload,
    ['quests_completed', 'quest_count'],
    (name, type) => name.includes('quests completed') || type.includes('quests_completed')
  );
}

function extractDeathsCount(statsPayload: any): number {
  return extractStatisticCount(
    statsPayload,
    ['deaths_count', 'total_deaths', 'deaths'],
    (name, type) => {
      const mentionsDeaths = name.includes('deaths') || type.includes('deaths');
      const mentionsDeath = name.includes('total deaths') || type.includes('total_death');
      return mentionsDeaths || mentionsDeath;
    }
  );
}

function extractCritterCount(statsPayload: any): number {
  return extractStatisticCount(
    statsPayload,
    ['critter_count', 'critters_killed', 'critter_kills', 'total_critters_killed'],
    (name, type, node) => {
      const statisticId = Number(node?.id ?? NaN);
      const normalized = `${name} ${type}`;
      return (
        statisticId === 108 ||
        normalized.includes('critters killed') ||
        normalized.includes('critter kills') ||
        normalized.includes('total critters killed') ||
        normalized.includes('wild pets slain') ||
        normalized.includes('critter')
      );
    }
  );
}

function normalizeHrefToUrl(href: string): URL | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed);
  } catch {
    if (trimmed.startsWith('/')) {
      try {
        return new URL(`${API_BASE}${trimmed}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildCharacterApiUrls(
  href: string
): { profileUrl: string; collectionBase: string; statisticsUrl: string; namespace: string } | null {
  const profileHref = normalizeHrefToUrl(href);
  if (!profileHref) {
    return null;
  }

  const namespace = profileHref.searchParams.get('namespace') ?? `profile-${REGION}`;
  const profileBase = `${profileHref.origin}${profileHref.pathname}`;

  return {
    profileUrl: `${profileBase}?namespace=${namespace}&locale=en_US`,
    collectionBase: `${profileBase}/collections`,
    statisticsUrl: `${profileBase}/achievements/statistics?namespace=${namespace}&locale=en_US`,
    namespace,
  };
}

async function getMeta(db: D1Database): Promise<RosterCacheStatus> {
  const now = nowInSeconds();
  const hasQuestCheckedColumn = await hasQuestCountCheckedColumn(db);
  const hasDeathsCheckedColumn = await hasDeathsCountCheckedColumn(db);
  const hasCritterCheckedColumn = await hasCritterCountCheckedColumn(db);
  const row = await db
    .prepare(
      `SELECT
          MAX(summary_synced_at) AS last_summary_sync,
          MAX(details_synced_at) AS last_detail_sync,
          SUM(
            CASE
              WHEN details_synced_at IS NULL OR details_synced_at < ?${hasQuestCheckedColumn ? ' OR quest_count_checked = 0' : ''}${hasDeathsCheckedColumn ? ' OR deaths_checked = 0' : ''}${hasCritterCheckedColumn ? ' OR critter_checked = 0' : ''}
              THEN 1
              ELSE 0
            END
          ) AS pending_detail_count
       FROM roster_members_cache`
    )
    .bind(now - DETAILS_TTL_SECONDS)
    .first<{ last_summary_sync: number | null; last_detail_sync: number | null; pending_detail_count: number | null }>();

  return {
    lastSummarySync: row?.last_summary_sync ?? null,
    lastDetailSync: row?.last_detail_sync ?? null,
    pendingDetailCount: Number(row?.pending_detail_count ?? 0),
  };
}

async function fetchAccessToken(): Promise<string> {
  if (!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) {
    throw new Error('Blizzard API credentials are not configured.');
  }

  const accessToken = await getBlizzardAppAccessToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);
  if (!accessToken) {
    throw new Error('Failed to obtain Blizzard access token.');
  }

  return accessToken;
}

async function fetchGuildRoster(accessToken: string): Promise<GuildRosterMember[]> {
  let rosterResponse: Response | null = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    rosterResponse = await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/guild/${GUILD_REALM_SLUG}/${GUILD_NAME_SLUG}/roster?namespace=profile-${REGION}&locale=en_US`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (rosterResponse.ok) {
      break;
    }

    const retryable = rosterResponse.status === 429 || rosterResponse.status >= 500;
    if (!retryable || attempt === 5) {
      break;
    }

    const retryAfterHeader = rosterResponse.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 0;
    const backoff = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 1500;
    await wait(backoff);
  }

  if (!rosterResponse?.ok) {
    let bodySnippet = '';
    try {
      const rawBody = await rosterResponse?.text();
      bodySnippet = rawBody ? ` body=${rawBody.slice(0, 200)}` : '';
    } catch {
      // Ignore body parsing issues; status code is the primary signal.
    }
    throw new Error(
      `Blizzard guild roster request failed (HTTP ${rosterResponse?.status ?? 'unknown'}).${bodySnippet}`
    );
  }

  const data = (await rosterResponse.json()) as { members?: GuildRosterMember[] };
  return Array.isArray(data.members) ? data.members : [];
}

async function pruneMissingMembers(db: D1Database, summarySyncTime: number): Promise<void> {
  await db
    .prepare('DELETE FROM roster_members_cache WHERE summary_synced_at < ?')
    .bind(summarySyncTime)
    .run();
}

async function listCachedMembers(db: D1Database): Promise<CachedRosterMember[]> {
  const hasQuestColumn = await hasQuestCountColumn(db);
  const hasDeathsColumn = await hasDeathsCountColumn(db);
  const hasCritterColumn = await hasCritterCountColumn(db);
  const result = await db
    .prepare(
      `SELECT
          blizzard_char_id,
          name,
          realm,
          realm_slug,
          class_name,
          race_name,
          level,
          rank,
          achievement_points,
          ${hasQuestColumn ? 'quest_count' : '0 AS quest_count'},
          ${hasDeathsColumn ? 'deaths_count' : '0 AS deaths_count'},
          ${hasCritterColumn ? 'critter_count' : '0 AS critter_count'},
          mount_count,
          pet_count,
          toy_count,
          details_synced_at
       FROM roster_members_cache
       ORDER BY rank ASC, name ASC`
    )
    .all<CacheRow>();

  return ((result.results ?? []) as CacheRow[]).map((row) => ({
    blizzardCharId: row.blizzard_char_id,
    name: row.name,
    realm: row.realm,
    realmSlug: row.realm_slug,
    className: row.class_name,
    raceName: row.race_name,
    level: row.level,
    rank: row.rank,
    achievementPoints: row.achievement_points,
    questCount: row.quest_count,
    deathsCount: row.deaths_count,
    critterCount: row.critter_count,
    mountCount: row.mount_count,
    petCount: row.pet_count,
    toyCount: row.toy_count,
    detailsSyncedAt: row.details_synced_at,
    classIconUrl: null,
  }));
}

export async function refreshRosterCache(
  dbInput?: D1Database,
  options?: RosterRefreshOptions
): Promise<RosterRefreshResult> {
  const db = getDatabase(dbInput);
  const refreshOptions = getRosterRefreshOptions(options);
  const hasQuestColumn = await hasQuestCountColumn(db);
  const hasQuestCheckedColumn = hasQuestColumn ? await hasQuestCountCheckedColumn(db) : false;
  const hasDeathsColumn = await hasDeathsCountColumn(db);
  const hasDeathsCheckedColumn = hasDeathsColumn ? await hasDeathsCountCheckedColumn(db) : false;
  const hasCritterColumn = await hasCritterCountColumn(db);
  const hasCritterCheckedColumn = hasCritterColumn ? await hasCritterCountCheckedColumn(db) : false;
  const accessToken = await fetchAccessToken();
  const rosterMembers = await fetchGuildRoster(accessToken);
  const now = nowInSeconds();
  const diagnostics: RosterRefreshDiagnostics = {
    totalMembers: rosterMembers.length,
    detailCandidatesSelected: 0,
    detailProcessed: 0,
    detailSkipped: 0,
    detailFailed: 0,
    detailPartial: 0,
    questBackfillSelected: 0,
    questBackfillProcessed: 0,
    deathsBackfillSelected: 0,
    deathsBackfillProcessed: 0,
    critterBackfillSelected: 0,
    critterBackfillProcessed: 0,
    profileFetchFailed: 0,
    statisticsFetchFailed: 0,
    mountsFetchFailed: 0,
    petsFetchFailed: 0,
    toysFetchFailed: 0,
  };

  const summaryStatements = rosterMembers.map((member) =>
    db
      .prepare(
        `INSERT INTO roster_members_cache (
            blizzard_char_id,
            name,
            realm,
            realm_slug,
            class_name,
            race_name,
            level,
            rank,
            summary_synced_at,
            updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(blizzard_char_id) DO UPDATE SET
            name = excluded.name,
            realm = excluded.realm,
            realm_slug = excluded.realm_slug,
          class_name = CASE WHEN excluded.class_name != 'Unknown' THEN excluded.class_name ELSE roster_members_cache.class_name END,
          race_name = CASE WHEN excluded.race_name != 'Unknown' THEN excluded.race_name ELSE roster_members_cache.race_name END,
            level = excluded.level,
            rank = excluded.rank,
            summary_synced_at = excluded.summary_synced_at,
            updated_at = excluded.updated_at`
      )
      .bind(
        member.character.id,
        member.character.name,
        member.character.realm.name ?? formatRealmFromSlug(member.character.realm.slug),
        member.character.realm.slug,
        resolveClassName(member.character.playable_class),
        resolveRaceName(member.character.playable_race),
        Number(member.character.level ?? 0),
        member.rank,
        now,
        now
      )
  );

  if (summaryStatements.length > 0) {
    await db.batch(summaryStatements);
  }

  await pruneMissingMembers(db, now);

  const detailCandidatesResult = await db
    .prepare(
      `SELECT
          blizzard_char_id,
          name,
          realm_slug,
          details_synced_at
       FROM roster_members_cache
       WHERE details_synced_at IS NULL OR details_synced_at < ?
       ORDER BY details_synced_at IS NOT NULL, details_synced_at ASC, rank ASC, name ASC`
    )
    .bind(now - DETAILS_TTL_SECONDS)
    .all<{
      blizzard_char_id: number;
      name: string;
      realm_slug: string;
      details_synced_at: number | null;
    }>();

  const detailCandidates = ((detailCandidatesResult.results ?? []) as Array<{
    blizzard_char_id: number;
    name: string;
    realm_slug: string;
    details_synced_at: number | null;
  }>).slice(0, Math.max(1, refreshOptions.batchSize));

  diagnostics.detailCandidatesSelected = detailCandidates.length;

  const rosterById = new Map(rosterMembers.map((member) => [member.character.id, member]));

  for (const candidate of detailCandidates) {
    try {
      const candidateId = Number(candidate.blizzard_char_id);
      const rosterMember = rosterById.get(candidateId);
      const href = rosterMember?.character.key?.href;
      if (!href) {
        diagnostics.detailSkipped += 1;
        continue;
      }

      const apiUrls = buildCharacterApiUrls(href);
      if (!apiUrls) {
        diagnostics.detailSkipped += 1;
        console.error('Roster detail refresh skipped: invalid profile href', {
          candidateId,
          href,
        });
        continue;
      }

      const [profile, stats, mounts, pets, toys] = await Promise.all([
        fetchOptionalBlizzardJson<CharacterProfileResponse>(apiUrls.profileUrl, accessToken),
        fetchOptionalBlizzardJson<any>(apiUrls.statisticsUrl, accessToken),
        fetchOptionalBlizzardJson<CharacterMountsResponse>(
          `${apiUrls.collectionBase}/mounts?namespace=${apiUrls.namespace}&locale=en_US`,
          accessToken
        ),
        fetchOptionalBlizzardJson<CharacterPetsResponse>(
          `${apiUrls.collectionBase}/pets?namespace=${apiUrls.namespace}&locale=en_US`,
          accessToken
        ),
        fetchOptionalBlizzardJson<CharacterToysResponse>(
          `${apiUrls.collectionBase}/toys?namespace=${apiUrls.namespace}&locale=en_US`,
          accessToken
        ),
      ]);

      if (!profile) {
        diagnostics.profileFetchFailed += 1;
        diagnostics.detailSkipped += 1;
        continue;
      }

      if (!stats) diagnostics.statisticsFetchFailed += 1;
      if (!mounts) diagnostics.mountsFetchFailed += 1;
      if (!pets) diagnostics.petsFetchFailed += 1;
      if (!toys) diagnostics.toysFetchFailed += 1;

      const extractedQuestCount = hasQuestColumn && stats ? extractQuestCount(stats) : 0;
      const extractedDeathsCount = hasDeathsColumn && stats ? extractDeathsCount(stats) : 0;
      const extractedCritterCount = hasCritterColumn && stats ? extractCritterCount(stats) : 0;
      const petEntries = Array.isArray(pets?.pets) ? pets.pets : [];
      const petSpeciesIds = petEntries
        .map((pet) => Number(pet.species?.id))
        .filter((id) => Number.isFinite(id));
      const uniquePetCount = petSpeciesIds.length > 0 ? new Set(petSpeciesIds).size : petEntries.length;
      const detailWasPartial = !stats || !mounts || !pets || !toys;

      await db
        .prepare(
          `UPDATE roster_members_cache
           SET realm = ?,
               class_name = ?,
               race_name = ?,
               level = ?,
               achievement_points = ?,
               ${hasQuestColumn ? 'quest_count = ?,' : ''}
               ${hasQuestCheckedColumn ? 'quest_count_checked = ?,' : ''}
               ${hasDeathsColumn ? 'deaths_count = ?,' : ''}
               ${hasDeathsCheckedColumn ? 'deaths_checked = ?,' : ''}
               ${hasCritterColumn ? 'critter_count = ?,' : ''}
               ${hasCritterCheckedColumn ? 'critter_checked = ?,' : ''}
               mount_count = ?,
               pet_count = ?,
               toy_count = ?,
               details_synced_at = ?,
               updated_at = ?
           WHERE blizzard_char_id = ?`
        )
        .bind(
          profile.realm?.name ?? formatRealmFromSlug(candidate.realm_slug),
          profile.character_class?.name ?? profile.playable_class?.name ?? 'Unknown',
          profile.race?.name ?? profile.playable_race?.name ?? 'Unknown',
          Number(profile.level ?? 0),
          Number(profile.achievement_points ?? 0),
          ...(hasQuestColumn ? [extractedQuestCount] : []),
          ...(hasQuestCheckedColumn ? [stats ? 1 : 0] : []),
          ...(hasDeathsColumn ? [extractedDeathsCount] : []),
          ...(hasDeathsCheckedColumn ? [stats ? 1 : 0] : []),
          ...(hasCritterColumn ? [extractedCritterCount] : []),
          ...(hasCritterCheckedColumn ? [stats ? 1 : 0] : []),
          Array.isArray(mounts?.mounts) ? mounts.mounts.length : 0,
          uniquePetCount,
          Array.isArray(toys?.toys) ? toys.toys.length : 0,
          now,
          now,
          candidateId
        )
        .run();

      diagnostics.detailProcessed += 1;
      if (detailWasPartial) {
        diagnostics.detailPartial += 1;
      }
    } catch (error) {
      diagnostics.detailFailed += 1;
      console.error('Roster detail refresh failed for candidate', {
        candidateId: candidate.blizzard_char_id,
        name: candidate.name,
        realmSlug: candidate.realm_slug,
        error,
      });
      continue;
    }
  }

  if (hasQuestCheckedColumn) {
    const questBackfillCandidatesResult = await db
      .prepare(
        `SELECT
            blizzard_char_id,
            name,
            realm_slug
         FROM roster_members_cache
         WHERE quest_count_checked = 0
         ORDER BY rank ASC, name ASC`
      )
      .all<{
        blizzard_char_id: number;
        name: string;
        realm_slug: string;
      }>();

    const questBackfillCandidates = ((questBackfillCandidatesResult.results ?? []) as Array<{
      blizzard_char_id: number;
      name: string;
      realm_slug: string;
    }>).slice(0, Math.max(1, refreshOptions.questBackfillBatchSize));

    diagnostics.questBackfillSelected = questBackfillCandidates.length;

    for (const candidate of questBackfillCandidates) {
      try {
        const candidateId = Number(candidate.blizzard_char_id);
        const rosterMember = rosterById.get(candidateId);
        const href = rosterMember?.character.key?.href;
        if (!href) {
          continue;
        }

        const apiUrls = buildCharacterApiUrls(href);
        if (!apiUrls) {
          console.error('Roster quest backfill skipped: invalid profile href', {
            candidateId,
            href,
          });
          continue;
        }

        const stats = await fetchBlizzardJsonWithRetry<any>(apiUrls.statisticsUrl, accessToken);
        if (!stats) {
          continue;
        }

        await db
          .prepare(
            `UPDATE roster_members_cache
             SET quest_count = ?,
                 quest_count_checked = 1,
                 updated_at = ?
             WHERE blizzard_char_id = ?`
          )
          .bind(extractQuestCount(stats), now, candidateId)
          .run();

        diagnostics.questBackfillProcessed += 1;
      } catch (error) {
        console.error('Roster quest backfill failed for candidate', {
          candidateId: candidate.blizzard_char_id,
          name: candidate.name,
          realmSlug: candidate.realm_slug,
          error,
        });
      }
    }
  }

  if (hasDeathsCheckedColumn) {
    const deathsBackfillCandidatesResult = await db
      .prepare(
        `SELECT
            blizzard_char_id,
            name,
            realm_slug
         FROM roster_members_cache
         WHERE deaths_checked = 0
         ORDER BY rank ASC, name ASC`
      )
      .all<{
        blizzard_char_id: number;
        name: string;
        realm_slug: string;
      }>();

    const deathsBackfillCandidates = ((deathsBackfillCandidatesResult.results ?? []) as Array<{
      blizzard_char_id: number;
      name: string;
      realm_slug: string;
    }>).slice(0, Math.max(1, refreshOptions.questBackfillBatchSize));

    diagnostics.deathsBackfillSelected = deathsBackfillCandidates.length;

    for (const candidate of deathsBackfillCandidates) {
      try {
        const candidateId = Number(candidate.blizzard_char_id);
        const rosterMember = rosterById.get(candidateId);
        const href = rosterMember?.character.key?.href;
        if (!href) {
          continue;
        }

        const apiUrls = buildCharacterApiUrls(href);
        if (!apiUrls) {
          console.error('Roster deaths backfill skipped: invalid profile href', {
            candidateId,
            href,
          });
          continue;
        }

        const stats = await fetchBlizzardJsonWithRetry<any>(apiUrls.statisticsUrl, accessToken);
        if (!stats) {
          continue;
        }

        await db
          .prepare(
            `UPDATE roster_members_cache
             SET deaths_count = ?,
                 deaths_checked = 1,
                 updated_at = ?
             WHERE blizzard_char_id = ?`
          )
          .bind(extractDeathsCount(stats), now, candidateId)
          .run();

        diagnostics.deathsBackfillProcessed += 1;
      } catch (error) {
        console.error('Roster deaths backfill failed for candidate', {
          candidateId: candidate.blizzard_char_id,
          name: candidate.name,
          realmSlug: candidate.realm_slug,
          error,
        });
      }
    }
  }

  if (hasCritterCheckedColumn) {
    const critterBackfillCandidatesResult = await db
      .prepare(
        `SELECT
            blizzard_char_id,
            name,
            realm_slug
         FROM roster_members_cache
         WHERE critter_checked = 0
         ORDER BY rank ASC, name ASC`
      )
      .all<{
        blizzard_char_id: number;
        name: string;
        realm_slug: string;
      }>();

    const critterBackfillCandidates = ((critterBackfillCandidatesResult.results ?? []) as Array<{
      blizzard_char_id: number;
      name: string;
      realm_slug: string;
    }>).slice(0, Math.max(1, refreshOptions.questBackfillBatchSize));

    diagnostics.critterBackfillSelected = critterBackfillCandidates.length;

    for (const candidate of critterBackfillCandidates) {
      try {
        const candidateId = Number(candidate.blizzard_char_id);
        const rosterMember = rosterById.get(candidateId);
        const href = rosterMember?.character.key?.href;
        if (!href) {
          continue;
        }

        const apiUrls = buildCharacterApiUrls(href);
        if (!apiUrls) {
          console.error('Roster critter backfill skipped: invalid profile href', {
            candidateId,
            href,
          });
          continue;
        }

        const stats = await fetchBlizzardJsonWithRetry<any>(apiUrls.statisticsUrl, accessToken);
        if (!stats) {
          continue;
        }

        await db
          .prepare(
            `UPDATE roster_members_cache
             SET critter_count = ?,
                 critter_checked = 1,
                 updated_at = ?
             WHERE blizzard_char_id = ?`
          )
          .bind(extractCritterCount(stats), now, candidateId)
          .run();

        diagnostics.critterBackfillProcessed += 1;
      } catch (error) {
        console.error('Roster critter backfill failed for candidate', {
          candidateId: candidate.blizzard_char_id,
          name: candidate.name,
          realmSlug: candidate.realm_slug,
          error,
        });
      }
    }
  }

  const status = await getMeta(db);

  console.log('Roster refresh completed', {
    status,
    diagnostics,
    options: refreshOptions,
  });

  return { status, diagnostics };
}

export async function loadRosterWithCache(
  dbInput?: D1Database
): Promise<{ members: CachedRosterMember[]; status: RosterCacheStatus; errorMessage: string }> {
  const db = getDatabase(dbInput);
  let errorMessage = '';
  let members = await listCachedMembers(db);
  let status = await getMeta(db);
  const now = nowInSeconds();

  const needsSummaryRefresh =
    members.length === 0 || !status.lastSummarySync || now - status.lastSummarySync > SUMMARY_TTL_SECONDS;
  const needsDetailRefresh = status.pendingDetailCount > 0;

  if (needsSummaryRefresh || needsDetailRefresh) {
    try {
      const refreshResult = await refreshRosterCache(db);
      status = refreshResult.status;
      members = await listCachedMembers(db);
    } catch (error) {
      if (members.length === 0) {
        errorMessage = error instanceof Error ? error.message : 'Unable to load roster from Blizzard API.';
      } else {
        console.error('Roster cache refresh failed:', error);
      }
    }
  }

  try {
    const accessToken = await fetchAccessToken();
    const classIcons = await loadBlizzardClassIconMap({
      accessToken,
      apiBase: API_BASE,
      staticNamespace: STATIC_NAMESPACE,
      locale: LOCALE,
      fetchJsonWithRetry: fetchBlizzardJsonWithRetry,
    });
    members = members.map((member) => ({
      ...member,
      classIconUrl:
        classIcons.get(normalizeWowClassName(member.className)) ??
        fallbackClassIconUrl(member.className),
    }));
  } catch (error) {
    // Non-fatal: class icons are decorative.
    console.error('Roster class icon load failed:', error);

    // Keep roster icons visible even if Blizzard media/index calls fail.
    members = members.map((member) => ({
      ...member,
      classIconUrl: fallbackClassIconUrl(member.className),
    }));
  }

  return { members, status, errorMessage };
}
