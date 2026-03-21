import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { resolveRaidProgressTier } from '../data/raidProgressTargets';
import { fallbackClassIconUrl, loadBlizzardClassIconMap, normalizeWowClassName } from './class-icons';
import { getBlizzardAppAccessToken as getSharedBlizzardAppAccessToken } from './blizzard-app-token';
import { fetchBlizzardJsonWithRetry } from './blizzard-fetch';

const API_BASE = 'https://us.api.blizzard.com';
const PROFILE_NAMESPACE = 'profile-us';
const STATIC_NAMESPACE = 'static-us';
const LOCALE = 'en_US';
const REQUEST_CONCURRENCY = 3;
const DETAILS_TTL_SECONDS = 12 * 60 * 60;
const DETAIL_BATCH_SIZE = 6;

const ENCHANTABLE_SLOTS = new Set([
  'BACK',
  'CHEST',
  'WRISTS',
  'HANDS',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'MAIN_HAND',
  'OFF_HAND',
]);

type RaiderAuthState = 'ready' | 'missing' | 'expired' | 'unavailable';

interface RaiderSourceRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  realm_slug: string;
  class_name: string;
  team_names: string | null;
}

interface CachedRaiderRow {
  blizzard_char_id: number;
  name: string;
  realm: string;
  realm_slug: string;
  class_name: string;
  team_names: string;
  auth_state: RaiderAuthState;
  equipped_item_level: number | null;
  average_item_level: number | null;
  mythic_score: number | null;
  tier_pieces_equipped: number | null;
  socketed_gems: number | null;
  total_sockets: number | null;
  enchanted_slots: number | null;
  enchantable_slots: number | null;
  raid_progress_raid_name: string | null;
  raid_progress_label: string | null;
  raid_progress_kills: number | null;
  raid_progress_total: number | null;
  details_synced_at: number | null;
}

interface BlizzardSummaryResponse {
  equipped_item_level?: number;
  average_item_level?: number;
}

interface BlizzardMediaResponse {
  assets?: Array<{ key: string; value: string }>;
}

interface BlizzardMythicProfileResponse {
  current_mythic_rating?: {
    rating?: number;
  };
}

interface BlizzardRaidEncountersResponse {
  expansions?: BlizzardRaidExpansion[];
}

interface BlizzardRaidExpansion {
  instances?: BlizzardRaidInstance[];
}

interface BlizzardRaidInstance {
  name?: string;
  instance?: {
    name?: string;
  };
  modes?: BlizzardRaidMode[];
}

interface BlizzardRaidMode {
  difficulty?: {
    type?: string;
  };
  progress?: {
    completed_count?: number;
    total_count?: number;
    encounters?: Array<{
      completed_timestamp?: number;
    }>;
  };
}

interface BlizzardEquipmentResponse {
  equipped_items?: BlizzardEquippedItem[];
}

interface BlizzardEquippedItem {
  slot?: {
    type?: string;
  };
  sockets?: Array<{
    item?: unknown;
    media?: unknown;
    display_string?: string;
  }>;
  enchantments?: Array<unknown>;
  item_set?: unknown;
  set?: unknown;
}

export interface RaiderRecord {
  blizzardCharId: number;
  name: string;
  realm: string;
  realmSlug: string;
  className: string;
  classIconUrl: string | null;
  teamNames: string[];
  authState: RaiderAuthState;
  lastCheckedAt: number | null;
  equippedItemLevel: number | null;
  averageItemLevel: number | null;
  mythicScore: number | null;
  tierPiecesEquipped: number | null;
  socketedGems: number | null;
  totalSockets: number | null;
  enchantedSlots: number | null;
  enchantableSlots: number | null;
  raidProgressRaidName: string | null;
  raidProgressLabel: string | null;
  raidProgressKills: number | null;
  raidProgressTotal: number | null;
}

export interface RaidersCacheStatus {
  lastSummarySync: number | null;
  lastDetailSync: number | null;
  pendingDetailCount: number;
}

export interface RaidersViewData {
  raiders: RaiderRecord[];
  totalMembers: number;
  readyCount: number;
  unavailableCount: number;
  status: RaidersCacheStatus;
  errorMessage: string;
}

function getDatabase(db?: D1Database): D1Database {
  return db ?? env.DB;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildCharacterUrl(realmSlug: string, characterName: string, suffix = ''): string {
  const encodedName = encodeURIComponent(characterName.toLowerCase());
  const path = `/profile/wow/character/${realmSlug}/${encodedName}${suffix}`;
  return `${API_BASE}${path}?namespace=${PROFILE_NAMESPACE}&locale=${LOCALE}`;
}

async function getBlizzardAppAccessToken(): Promise<string | null> {
  return getSharedBlizzardAppAccessToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);
}

async function ensureClassIconCache(): Promise<Map<string, string>> {
  const accessToken = await getBlizzardAppAccessToken();
  if (!accessToken) {
    return new Map<string, string>();
  }

  return loadBlizzardClassIconMap({
    accessToken,
    apiBase: API_BASE,
    staticNamespace: STATIC_NAMESPACE,
    locale: LOCALE,
    requestConcurrency: REQUEST_CONCURRENCY,
    fetchJsonWithRetry: fetchBlizzardJsonWithRetry,
  });
}

function normalizeTeamNames(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function countTierPieces(items: BlizzardEquippedItem[]): number {
  return items.reduce((count, item) => (item.item_set || item.set ? count + 1 : count), 0);
}

function countSockets(items: BlizzardEquippedItem[]): { socketed: number; total: number } {
  let total = 0;
  let socketed = 0;

  for (const item of items) {
    for (const socket of item.sockets ?? []) {
      total += 1;
      if (socket.item || socket.media || socket.display_string) {
        socketed += 1;
      }
    }
  }

  return { socketed, total };
}

function countEnchants(items: BlizzardEquippedItem[]): { filled: number; total: number } {
  let total = 0;
  let filled = 0;

  for (const item of items) {
    const slotType = item.slot?.type ?? '';
    if (!ENCHANTABLE_SLOTS.has(slotType)) continue;

    total += 1;
    if ((item.enchantments?.length ?? 0) > 0) {
      filled += 1;
    }
  }

  return { filled, total };
}

function normalizeRaidName(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRaidProgress(encounters: BlizzardRaidEncountersResponse | null, raidProgressTarget: string): {
  raidName: string | null;
  label: string | null;
  kills: number | null;
  total: number | null;
} {
  const selectedTier = resolveRaidProgressTier(raidProgressTarget);
  if (!selectedTier || !encounters?.expansions?.length) {
    return { raidName: null, label: null, kills: null, total: null };
  }

  const raidByName = new Map(selectedTier.raids.map((raid) => [normalizeRaidName(raid.raidName), raid]));
  const modeMap: Record<string, 'L' | 'N' | 'H' | 'M'> = {
    LFR: 'L',
    NORMAL: 'N',
    HEROIC: 'H',
    MYTHIC: 'M',
  };

  const progress = new Map<string, Record<'L' | 'N' | 'H' | 'M', { kills: number; total: number }>>(
    selectedTier.raids.map((raid) => [
      raid.code,
      {
        L: { kills: 0, total: 0 },
        N: { kills: 0, total: 0 },
        H: { kills: 0, total: 0 },
        M: { kills: 0, total: 0 },
      },
    ])
  );

  for (const expansion of encounters.expansions) {
    for (const instance of expansion.instances ?? []) {
      const instanceName = normalizeRaidName(instance.name ?? instance.instance?.name ?? '');
      const raid = raidByName.get(instanceName);
      if (!raid) continue;

      const raidProgress = progress.get(raid.code);
      if (!raidProgress) continue;

      for (const mode of instance.modes ?? []) {
        const modeType = (mode.difficulty?.type ?? '').toUpperCase();
        const modeCode = modeMap[modeType];
        if (!modeCode) continue;

        const kills = Number(mode.progress?.completed_count ?? 0);
        const total = Number(mode.progress?.total_count ?? 0);
        raidProgress[modeCode] = {
          kills: Math.max(raidProgress[modeCode].kills, kills),
          total: Math.max(raidProgress[modeCode].total, total),
        };
      }
    }
  }

  const anyProgressData = [...progress.values()].some((raidProgress) =>
    Object.values(raidProgress).some((entry) => entry.total > 0 || entry.kills > 0)
  );
  if (!anyProgressData) {
    return { raidName: null, label: null, kills: null, total: null };
  }

  const modes: Array<'L' | 'N' | 'H' | 'M'> = ['L', 'N', 'H', 'M'];
  const valueByMode = (modeCode: 'L' | 'N' | 'H' | 'M') =>
    selectedTier.raids.map((raid) => {
      const raidProgress = progress.get(raid.code)!;
      return `${raidProgress[modeCode].kills}/${raidProgress[modeCode].total}`;
    });

  const label = JSON.stringify({
    headers: selectedTier.raids.map((raid) => raid.code),
    rows: modes.map((mode) => ({ mode, cells: valueByMode(mode) })),
  });

  const sumFor = (modeCode: 'L' | 'N' | 'H' | 'M') =>
    selectedTier.raids.reduce((sum, raid) => sum + (progress.get(raid.code)?.[modeCode].kills ?? 0), 0);

  const sortScore = sumFor('M') * 1_000_000 + sumFor('H') * 10_000 + sumFor('N') * 100 + sumFor('L');
  const aggregateTotal = selectedTier.raids.reduce(
    (sum, raid) => sum + (progress.get(raid.code)?.M.total ?? progress.get(raid.code)?.H.total ?? progress.get(raid.code)?.N.total ?? progress.get(raid.code)?.L.total ?? 0),
    0
  );

  return {
    raidName: selectedTier.id,
    label,
    kills: sortScore,
    total: aggregateTotal || null,
  };
}

async function enrichRaider(row: RaiderSourceRow, now: number, raidProgressTarget: string): Promise<RaiderRecord> {
  const baseRecord: RaiderRecord = {
    blizzardCharId: row.blizzard_char_id,
    name: row.name,
    realm: row.realm,
    realmSlug: row.realm_slug,
    className: row.class_name,
    classIconUrl: null,
    teamNames: normalizeTeamNames(row.team_names),
    authState: 'missing',
    lastCheckedAt: null,
    equippedItemLevel: null,
    averageItemLevel: null,
    mythicScore: null,
    tierPiecesEquipped: null,
    socketedGems: null,
    totalSockets: null,
    enchantedSlots: null,
    enchantableSlots: null,
    raidProgressRaidName: null,
    raidProgressLabel: null,
    raidProgressKills: null,
    raidProgressTotal: null,
  };

  const accessToken = await getBlizzardAppAccessToken();
  if (!accessToken) {
    return { ...baseRecord, authState: 'unavailable' };
  }

  const [summary, equipment, mythicProfile, raidEncounters] = await Promise.all([
    fetchBlizzardJsonWithRetry<BlizzardSummaryResponse>(buildCharacterUrl(row.realm_slug, row.name), accessToken),
    fetchBlizzardJsonWithRetry<BlizzardEquipmentResponse>(buildCharacterUrl(row.realm_slug, row.name, '/equipment'), accessToken),
    fetchBlizzardJsonWithRetry<BlizzardMythicProfileResponse>(
      buildCharacterUrl(row.realm_slug, row.name, '/mythic-keystone-profile'),
      accessToken
    ),
    fetchBlizzardJsonWithRetry<BlizzardRaidEncountersResponse>(
      buildCharacterUrl(row.realm_slug, row.name, '/encounters/raids'),
      accessToken
    ),
  ]);

  if (!summary || !equipment) {
    return { ...baseRecord, authState: 'unavailable' };
  }

  const equippedItems = equipment.equipped_items ?? [];
  const socketCounts = countSockets(equippedItems);
  const enchantCounts = countEnchants(equippedItems);
  const raidProgress = extractRaidProgress(raidEncounters, raidProgressTarget);

  return {
    ...baseRecord,
    authState: 'ready',
    lastCheckedAt: now,
    equippedItemLevel: Number(summary.equipped_item_level ?? 0) || null,
    averageItemLevel: Number(summary.average_item_level ?? 0) || null,
    mythicScore: Number(mythicProfile?.current_mythic_rating?.rating ?? 0) || null,
    tierPiecesEquipped: countTierPieces(equippedItems),
    socketedGems: socketCounts.socketed,
    totalSockets: socketCounts.total,
    enchantedSlots: enchantCounts.filled,
    enchantableSlots: enchantCounts.total,
    raidProgressRaidName: raidProgress.raidName,
    raidProgressLabel: raidProgress.label,
    raidProgressKills: raidProgress.kills,
    raidProgressTotal: raidProgress.total,
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));

  return results;
}

async function getCacheStatus(db: D1Database): Promise<RaidersCacheStatus> {
  const now = nowInSeconds();
  const row = await db
    .prepare(
      `SELECT
          MAX(summary_synced_at) AS last_summary_sync,
          MAX(details_synced_at) AS last_detail_sync,
          SUM(
            CASE
              WHEN details_synced_at IS NULL OR details_synced_at < ?
              THEN 1
              ELSE 0
            END
          ) AS pending_detail_count
       FROM raider_metrics_cache`
    )
    .bind(now - DETAILS_TTL_SECONDS)
    .first<{ last_summary_sync: number | null; last_detail_sync: number | null; pending_detail_count: number | null }>();

  return {
    lastSummarySync: row?.last_summary_sync ?? null,
    lastDetailSync: row?.last_detail_sync ?? null,
    pendingDetailCount: Number(row?.pending_detail_count ?? 0),
  };
}

async function listCachedRaiders(db: D1Database): Promise<RaiderRecord[]> {
  const result = await db
    .prepare(
      `SELECT
          blizzard_char_id,
          name,
          realm,
          realm_slug,
          class_name,
          team_names,
          auth_state,
          equipped_item_level,
          average_item_level,
          mythic_score,
          tier_pieces_equipped,
          socketed_gems,
          total_sockets,
          enchanted_slots,
            enchantable_slots,
          raid_progress_raid_name,
            raid_progress_label,
            raid_progress_kills,
            raid_progress_total,
            details_synced_at
       FROM raider_metrics_cache
       ORDER BY class_name ASC, name ASC`
    )
    .all<CachedRaiderRow>();

  return ((result.results ?? []) as CachedRaiderRow[]).map((row) => ({
    blizzardCharId: row.blizzard_char_id,
    name: row.name,
    realm: row.realm,
    realmSlug: row.realm_slug,
    className: row.class_name,
    classIconUrl: null,
    teamNames: normalizeTeamNames(row.team_names),
    authState: row.auth_state,
    lastCheckedAt: row.details_synced_at,
    equippedItemLevel: row.equipped_item_level,
    averageItemLevel: row.average_item_level,
    mythicScore: row.mythic_score,
    tierPiecesEquipped: row.tier_pieces_equipped,
    socketedGems: row.socketed_gems,
    totalSockets: row.total_sockets,
    enchantedSlots: row.enchanted_slots,
    enchantableSlots: row.enchantable_slots,
    raidProgressRaidName: row.raid_progress_raid_name,
    raidProgressLabel: row.raid_progress_label,
    raidProgressKills: row.raid_progress_kills,
    raidProgressTotal: row.raid_progress_total,
  }));
}

async function pruneMissingRaiders(db: D1Database, summarySyncTime: number): Promise<void> {
  await db.prepare('DELETE FROM raider_metrics_cache WHERE summary_synced_at < ?').bind(summarySyncTime).run();
}

async function upsertSummaryRows(db: D1Database, rows: RaiderSourceRow[], now: number): Promise<void> {
  if (rows.length === 0) return;

  const statements = rows.map((row) => {
    return db
      .prepare(
        `INSERT INTO raider_metrics_cache (
            blizzard_char_id,
            name,
            realm,
            realm_slug,
            class_name,
            team_names,
            auth_state,
            source_token_expires_at,
            summary_synced_at,
            updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(blizzard_char_id) DO UPDATE SET
            name = excluded.name,
            realm = excluded.realm,
            realm_slug = excluded.realm_slug,
            class_name = excluded.class_name,
            team_names = excluded.team_names,
            auth_state = CASE
              WHEN raider_metrics_cache.name <> excluded.name
                OR raider_metrics_cache.realm <> excluded.realm
                OR raider_metrics_cache.realm_slug <> excluded.realm_slug
              THEN 'missing'
              WHEN raider_metrics_cache.auth_state = 'expired'
              THEN 'missing'
              ELSE raider_metrics_cache.auth_state
            END,
            source_token_expires_at = NULL,
            details_synced_at = CASE
              WHEN raider_metrics_cache.name <> excluded.name
                OR raider_metrics_cache.realm <> excluded.realm
                OR raider_metrics_cache.realm_slug <> excluded.realm_slug
              THEN NULL
              ELSE raider_metrics_cache.details_synced_at
            END,
            summary_synced_at = excluded.summary_synced_at,
            updated_at = excluded.updated_at`
      )
      .bind(
        row.blizzard_char_id,
        row.name,
        row.realm,
        row.realm_slug,
        row.class_name,
        normalizeTeamNames(row.team_names).join(', '),
        'missing',
        null,
        now,
        now
      );
  });

  await db.batch(statements);
}

async function getRaidProgressTarget(db: D1Database): Promise<string> {
  try {
    const row = await db
      .prepare(`SELECT value FROM site_settings WHERE key = 'raid_progress_target' LIMIT 1`)
      .first<{ value: string | null }>();

    return (row?.value ?? '').trim();
  } catch {
    // If migration is not applied yet, fallback to unset target.
    return '';
  }
}

async function listDetailCandidates(
  db: D1Database,
  now: number,
  batchSize: number,
  effectiveRaidProgressTierId: string
): Promise<RaiderSourceRow[]> {
  const result = await db
    .prepare(
      `SELECT
         rmc.blizzard_char_id,
         rmc.name,
         rmc.realm,
         rmc.realm_slug,
         rmc.class_name,
         rmc.team_names
       FROM raider_metrics_cache rmc
       WHERE (
           rmc.raid_progress_label IS NULL
           OR (
               ? <> ''
               AND (rmc.raid_progress_raid_name IS NULL OR LOWER(rmc.raid_progress_raid_name) <> LOWER(?))
             )
             OR (
               ? <> ''
               AND rmc.raid_progress_label IS NOT NULL
             AND TRIM(rmc.raid_progress_label) NOT LIKE '{%'
           )
           OR rmc.details_synced_at IS NULL
           OR rmc.details_synced_at < ?
         )
       ORDER BY rmc.details_synced_at IS NOT NULL, rmc.details_synced_at ASC, rmc.name ASC
       LIMIT ?`
    )
      .bind(
        effectiveRaidProgressTierId,
        effectiveRaidProgressTierId,
        effectiveRaidProgressTierId,
        now - DETAILS_TTL_SECONDS,
        batchSize
      )
    .all<RaiderSourceRow>();

  return (result.results ?? []) as RaiderSourceRow[];
}

export async function refreshRaidersCache(
  dbInput?: D1Database,
  options?: { batchSize?: number; skipDetails?: boolean }
): Promise<RaidersCacheStatus> {
  const db = getDatabase(dbInput);
  const now = nowInSeconds();
  const configuredRaidProgressTarget = await getRaidProgressTarget(db);
  const effectiveRaidProgressTierId =
    resolveRaidProgressTier(configuredRaidProgressTarget)?.id ?? '';

  const sourceResult = await db
    .prepare(
      `SELECT
         rmc.blizzard_char_id,
         rmc.name,
         rmc.realm,
         rmc.realm_slug,
        rmc.class_name,
        GROUP_CONCAT(DISTINCT rt.name) AS team_names
       FROM raid_team_members rtm
       JOIN raid_teams rt ON rt.id = rtm.team_id
       JOIN roster_members_cache rmc ON rmc.blizzard_char_id = rtm.blizzard_char_id
       WHERE rt.is_archived = 0
       GROUP BY rmc.blizzard_char_id, rmc.name, rmc.realm, rmc.realm_slug, rmc.class_name`
    )
    .all<RaiderSourceRow>();

  const sourceRows = (sourceResult.results ?? []) as RaiderSourceRow[];

  await upsertSummaryRows(db, sourceRows, now);
  await pruneMissingRaiders(db, now);

  const skipDetails = options?.skipDetails === true;
  const detailCandidates = skipDetails
    ? []
    : await listDetailCandidates(
        db,
        now,
        Math.max(1, options?.batchSize ?? DETAIL_BATCH_SIZE),
        effectiveRaidProgressTierId
      );
  const detailedRaiders = await mapWithConcurrency(detailCandidates, REQUEST_CONCURRENCY, (row) =>
    enrichRaider(row, now, effectiveRaidProgressTierId)
  );

  for (let i = 0; i < detailCandidates.length; i += 1) {
    const source = detailCandidates[i];
    const detailed = detailedRaiders[i];

    await db
      .prepare(
        `UPDATE raider_metrics_cache
         SET auth_state = ?,
             equipped_item_level = ?,
             average_item_level = ?,
             mythic_score = ?,
             tier_pieces_equipped = ?,
             socketed_gems = ?,
             total_sockets = ?,
             enchanted_slots = ?,
             enchantable_slots = ?,
             raid_progress_raid_name = ?,
             raid_progress_label = ?,
             raid_progress_kills = ?,
             raid_progress_total = ?,
             source_token_expires_at = ?,
             details_synced_at = ?,
             updated_at = ?
         WHERE blizzard_char_id = ?`
      )
      .bind(
        detailed.authState,
        detailed.equippedItemLevel,
        detailed.averageItemLevel,
        detailed.mythicScore,
        detailed.tierPiecesEquipped,
        detailed.socketedGems,
        detailed.totalSockets,
        detailed.enchantedSlots,
        detailed.enchantableSlots,
        detailed.raidProgressRaidName,
        detailed.raidProgressLabel,
        detailed.raidProgressKills,
        detailed.raidProgressTotal,
        null,
        now,
        now,
        source.blizzard_char_id
      )
      .run();
  }

  return getCacheStatus(db);
}

export async function getRaiderMedia(charId: number, dbInput?: D1Database): Promise<{ portrait: string | null; fullBody: string | null }> {
  const db = getDatabase(dbInput);

  const row = await db
    .prepare(
      `SELECT rmc.name, rmc.realm_slug
       FROM raider_metrics_cache rmc
       WHERE rmc.blizzard_char_id = ?`
    )
    .bind(charId)
    .first<{ name: string; realm_slug: string }>();

  const accessToken = await getBlizzardAppAccessToken();
  if (!row || !accessToken) {
    return { portrait: null, fullBody: null };
  }

  const url = buildCharacterUrl(row.realm_slug, row.name, '/character-media');
  const media = await fetchBlizzardJsonWithRetry<BlizzardMediaResponse>(url, accessToken);
  if (!media?.assets) return { portrait: null, fullBody: null };

  const find = (keys: string[]) => {
    for (const key of keys) {
      const asset = media.assets!.find((a) => a.key === key);
      if (asset?.value) return asset.value;
    }
    return null;
  };

  return {
    portrait: find(['inset', 'avatar']),
    fullBody: find(['main-raw', 'main']),
  };
}

/** @deprecated Use getRaiderMedia instead */
export async function getRaiderMediaUrl(charId: number, dbInput?: D1Database): Promise<string | null> {
  const { fullBody, portrait } = await getRaiderMedia(charId, dbInput);
  return fullBody ?? portrait;
}

export async function getRaiderByCharId(charId: number, dbInput?: D1Database): Promise<RaiderRecord | null> {
  const db = getDatabase(dbInput);
  const row = await db
    .prepare(
      `SELECT
          blizzard_char_id,
          name,
          realm,
          realm_slug,
          class_name,
          team_names,
          auth_state,
          equipped_item_level,
          average_item_level,
          mythic_score,
          tier_pieces_equipped,
          socketed_gems,
          total_sockets,
          enchanted_slots,
          enchantable_slots,
          raid_progress_raid_name,
           raid_progress_label,
           raid_progress_kills,
           raid_progress_total,
          details_synced_at
       FROM raider_metrics_cache
       WHERE blizzard_char_id = ?`
    )
    .bind(charId)
    .first<CachedRaiderRow>();

  if (!row) return null;

  return {
    blizzardCharId: row.blizzard_char_id,
    name: row.name,
    realm: row.realm,
    realmSlug: row.realm_slug,
    className: row.class_name,
    classIconUrl: null,
    teamNames: normalizeTeamNames(row.team_names),
    authState: row.auth_state,
    lastCheckedAt: row.details_synced_at,
    equippedItemLevel: row.equipped_item_level,
    averageItemLevel: row.average_item_level,
    mythicScore: row.mythic_score,
    tierPiecesEquipped: row.tier_pieces_equipped,
    socketedGems: row.socketed_gems,
    totalSockets: row.total_sockets,
    enchantedSlots: row.enchanted_slots,
    enchantableSlots: row.enchantable_slots,
    raidProgressRaidName: row.raid_progress_raid_name,
    raidProgressLabel: row.raid_progress_label,
    raidProgressKills: row.raid_progress_kills,
    raidProgressTotal: row.raid_progress_total,
  };
}

export async function loadRaidersViewData(dbInput?: D1Database): Promise<RaidersViewData> {
  const db = getDatabase(dbInput);
  let errorMessage = '';
  let raiders = await listCachedRaiders(db);
  let status = await getCacheStatus(db);

  // Keep roster-team membership and queue state current without triggering heavy Blizzard detail fan-out.
  try {
    status = await refreshRaidersCache(db, { skipDetails: true });
    raiders = await listCachedRaiders(db);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to refresh Raiders cache summary.';
  }

  if (raiders.length === 0) {
    try {
      status = await refreshRaidersCache(db, { batchSize: DETAIL_BATCH_SIZE });
      raiders = await listCachedRaiders(db);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unable to refresh Raiders cache.';
    }
  }

  // Backfill legacy single-raid progress labels into tier-bundle matrix format.
  const needsRaidProgressBackfill = raiders.some(
    (raider) =>
      raider.authState === 'ready' &&
      Boolean(raider.raidProgressLabel) &&
      !raider.raidProgressLabel!.trimStart().startsWith('{')
  );

  if (needsRaidProgressBackfill) {
    try {
      status = await refreshRaidersCache(db, { batchSize: 2 });
      raiders = await listCachedRaiders(db);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unable to backfill Raiders raid progress.';
    }
  }

  try {
    const classIcons = await ensureClassIconCache();
    raiders = raiders.map((raider) => ({
      ...raider,
      classIconUrl:
        classIcons.get(normalizeWowClassName(raider.className)) ??
        fallbackClassIconUrl(raider.className),
    }));
  } catch {
    // Non-fatal: class icons are decorative.
  }

  return {
    raiders,
    totalMembers: raiders.length,
    readyCount: raiders.filter((raider) => raider.authState === 'ready').length,
    unavailableCount: raiders.filter((raider) => raider.authState !== 'ready').length,
    status,
    errorMessage,
  };
}
