import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';

const GUILD_REALM_SLUG = 'illidan';
const GUILD_NAME_SLUG = 'hidden-lodge';
const REGION = 'us';
const SUMMARY_TTL_SECONDS = 15 * 60;
const DETAILS_TTL_SECONDS = 24 * 60 * 60;
const DETAIL_BATCH_SIZE = 8;
const API_BASE = `https://${REGION}.api.blizzard.com`;

interface GuildRosterMember {
  character: {
    key?: { href?: string };
    id: number;
    name: string;
    realm: { slug: string; name?: string };
    level?: number;
    playable_class?: { name?: string };
    playable_race?: { name?: string };
  };
  rank: number;
}

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
  mountCount: number;
  petCount: number;
  toyCount: number;
  detailsSyncedAt: number | null;
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

async function getMeta(db: D1Database): Promise<RosterCacheStatus> {
  const now = nowInSeconds();
  const row = await db
    .prepare(
      `SELECT
          MAX(summary_synced_at) AS last_summary_sync,
          MAX(details_synced_at) AS last_detail_sync,
          SUM(CASE WHEN details_synced_at IS NULL OR details_synced_at < ? THEN 1 ELSE 0 END) AS pending_detail_count
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

  const credentials = btoa(`${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`);
  const response = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain Blizzard access token (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url: string, accessToken: string, attempts = 3): Promise<any | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) {
      return await response.json();
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      return null;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 0;
    const backoff = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 500;
    await delay(backoff);
  }

  return null;
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
    await delay(backoff);
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
    mountCount: row.mount_count,
    petCount: row.pet_count,
    toyCount: row.toy_count,
    detailsSyncedAt: row.details_synced_at,
  }));
}

export async function refreshRosterCache(
  dbInput?: D1Database,
  options?: { batchSize?: number }
): Promise<RosterCacheStatus> {
  const db = getDatabase(dbInput);
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
        member.character.playable_class?.name ?? 'Unknown',
        member.character.playable_race?.name ?? 'Unknown',
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

  const normalizeHrefToUrl = (href: string): URL | null => {
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
  };

  for (const candidate of detailCandidates) {
    try {
      const candidateId = Number(candidate.blizzard_char_id);
      const rosterMember = rosterById.get(candidateId);
      const href = rosterMember?.character.key?.href;
      if (!href) {
        continue;
      }

      const profileHref = normalizeHrefToUrl(href);
      if (!profileHref) {
        console.error('Roster detail refresh skipped: invalid profile href', {
          candidateId,
          href,
        });
        continue;
      }

      const namespace = profileHref.searchParams.get('namespace') ?? `profile-${REGION}`;
      const profileBase = `${profileHref.origin}${profileHref.pathname}`;
      const profileUrl = `${profileBase}?namespace=${namespace}&locale=en_US`;
      const collectionBase = `${profileBase}/collections`;

      const [profile, mounts, pets, toys] = await Promise.all([
        fetchJsonWithRetry(profileUrl, accessToken),
        fetchJsonWithRetry(`${collectionBase}/mounts?namespace=${namespace}&locale=en_US`, accessToken),
        fetchJsonWithRetry(`${collectionBase}/pets?namespace=${namespace}&locale=en_US`, accessToken),
        fetchJsonWithRetry(`${collectionBase}/toys?namespace=${namespace}&locale=en_US`, accessToken),
      ]);

      if (!profile || !mounts || !pets || !toys) {
        continue;
      }

      await db
        .prepare(
          `UPDATE roster_members_cache
           SET realm = ?,
               class_name = ?,
               race_name = ?,
               level = ?,
               achievement_points = ?,
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

  return { members, status, errorMessage };
}
