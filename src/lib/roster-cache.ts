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
  pets?: unknown[];
}

interface CharacterToysResponse {
  toys?: unknown[];
}

let rosterQuestColumnState: boolean | null = null;
let rosterQuestCheckedColumnState: boolean | null = null;

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

function getDatabase(db?: D1Database): D1Database {
  return db ?? env.DB;
}

async function hasQuestCountColumn(db: D1Database): Promise<boolean> {
  if (rosterQuestColumnState !== null) {
    return rosterQuestColumnState;
  }

  try {
    const pragma = await db.prepare('PRAGMA table_info(roster_members_cache)').all<{ name: string }>();
    const columns = (pragma.results ?? []) as Array<{ name?: string }>;
    rosterQuestColumnState = columns.some((column) => column.name === 'quest_count');
  } catch {
    rosterQuestColumnState = false;
  }

  return rosterQuestColumnState;
}

async function hasQuestCountCheckedColumn(db: D1Database): Promise<boolean> {
  if (rosterQuestCheckedColumnState !== null) {
    return rosterQuestCheckedColumnState;
  }

  try {
    const pragma = await db.prepare('PRAGMA table_info(roster_members_cache)').all<{ name: string }>();
    const columns = (pragma.results ?? []) as Array<{ name?: string }>;
    rosterQuestCheckedColumnState = columns.some((column) => column.name === 'quest_count_checked');
  } catch {
    rosterQuestCheckedColumnState = false;
  }

  return rosterQuestCheckedColumnState;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractQuestCount(statsPayload: any): number {
  if (!statsPayload || typeof statsPayload !== 'object') return 0;

  const direct = Number(statsPayload.quests_completed ?? statsPayload.quest_count ?? 0);
  if (direct > 0) return direct;

  const visit = (node: any): number | null => {
    if (!node || typeof node !== 'object') return null;

    const name = String(node.name ?? '').toLowerCase();
    const type = String(node.type ?? '').toLowerCase();
    const quantity = Number(node.quantity ?? node.value ?? NaN);
    if (Number.isFinite(quantity) && quantity >= 0) {
      if (name.includes('quests completed') || type.includes('quests_completed')) {
        return quantity;
      }
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
  const row = await db
    .prepare(
      `SELECT
          MAX(summary_synced_at) AS last_summary_sync,
          MAX(details_synced_at) AS last_detail_sync,
          SUM(
            CASE
              WHEN details_synced_at IS NULL OR details_synced_at < ?${hasQuestCheckedColumn ? ' OR quest_count_checked = 0' : ''}
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
    mountCount: row.mount_count,
    petCount: row.pet_count,
    toyCount: row.toy_count,
    detailsSyncedAt: row.details_synced_at,
    classIconUrl: null,
  }));
}

export async function refreshRosterCache(
  dbInput?: D1Database,
  options?: { batchSize?: number; questBackfillBatchSize?: number }
): Promise<RosterCacheStatus> {
  const db = getDatabase(dbInput);
  const hasQuestColumn = await hasQuestCountColumn(db);
  const hasQuestCheckedColumn = hasQuestColumn ? await hasQuestCountCheckedColumn(db) : false;
  const accessToken = await fetchAccessToken();
  const rosterMembers = await fetchGuildRoster(accessToken);
  const now = nowInSeconds();

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
  }>).slice(0, Math.max(1, options?.batchSize ?? DETAIL_BATCH_SIZE));

  const rosterById = new Map(rosterMembers.map((member) => [member.character.id, member]));

  for (const candidate of detailCandidates) {
    try {
      const candidateId = Number(candidate.blizzard_char_id);
      const rosterMember = rosterById.get(candidateId);
      const href = rosterMember?.character.key?.href;
      if (!href) {
        continue;
      }

      const apiUrls = buildCharacterApiUrls(href);
      if (!apiUrls) {
        console.error('Roster detail refresh skipped: invalid profile href', {
          candidateId,
          href,
        });
        continue;
      }

      const [profile, stats, mounts, pets, toys] = await Promise.all([
        fetchBlizzardJsonWithRetry<CharacterProfileResponse>(apiUrls.profileUrl, accessToken),
        fetchBlizzardJsonWithRetry<any>(apiUrls.statisticsUrl, accessToken),
        fetchBlizzardJsonWithRetry<CharacterMountsResponse>(`${apiUrls.collectionBase}/mounts?namespace=${apiUrls.namespace}&locale=en_US`, accessToken),
        fetchBlizzardJsonWithRetry<CharacterPetsResponse>(`${apiUrls.collectionBase}/pets?namespace=${apiUrls.namespace}&locale=en_US`, accessToken),
        fetchBlizzardJsonWithRetry<CharacterToysResponse>(`${apiUrls.collectionBase}/toys?namespace=${apiUrls.namespace}&locale=en_US`, accessToken),
      ]);

      if (!profile || !stats || !mounts || !pets || !toys) {
        continue;
      }

      const extractedQuestCount = hasQuestColumn ? extractQuestCount(stats) : 0;

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
          ...(hasQuestCheckedColumn ? [1] : []),
          Array.isArray(mounts.mounts) ? mounts.mounts.length : 0,
          Array.isArray(pets.pets) ? pets.pets.length : 0,
          Array.isArray(toys.toys) ? toys.toys.length : 0,
          now,
          now,
          candidateId
        )
        .run();
    } catch (error) {
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
    }>).slice(0, Math.max(1, options?.questBackfillBatchSize ?? QUEST_BACKFILL_BATCH_SIZE));

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

  return getMeta(db);
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
      status = await refreshRosterCache(db);
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
  }

  return { members, status, errorMessage };
}
