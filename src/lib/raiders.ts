import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { resolveRaidProgressTier } from '../data/raidProgressTargets';
import { fallbackClassIconUrl } from './class-icons';
import { getLatestDroptimizerForRaiders, getLatestSingleTargetForRaiders } from './sim-api';
import { getBlizzardAppAccessToken as getSharedBlizzardAppAccessToken } from './blizzard-app-token';
import { fetchBlizzardJsonWithRetry } from './blizzard-fetch';
import { getCharacterMythicPlusRunCounts, fetchStatisticsWeeklyTotal, type KeystoneRun } from './raider-io';

const API_BASE = 'https://us.api.blizzard.com';
const PROFILE_NAMESPACE = 'profile-us';
const LOCALE = 'en_US';
const REQUEST_CONCURRENCY = 3;
const DETAILS_TTL_SECONDS = 12 * 60 * 60;
const DETAIL_BATCH_SIZE = 6;
const PREPAREDNESS_HISTORY_WINDOW_SECONDS = 14 * 24 * 60 * 60; // 14 days (2 weeks)
const PROGRESSION_HISTORY_WINDOW_SECONDS = 28 * 24 * 60 * 60; // 28 days (4 weeks)
const VAULT_HISTORY_WINDOW_SECONDS = 28 * 24 * 60 * 60; // 28 days (4 weeks)
const MIDNIGHT_SEASON_1_START_TIMESTAMP = Math.floor(Date.UTC(2026, 2, 24, 15, 0, 0, 0) / 1000);
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const US_WEEKLY_RESET_HOUR_EASTERN = 10;
const DELVES_TOTAL_STAT_ID = 40734;

const CREST_STAT_IDS = {
  adventurer: 62292,
  veteran: 62293,
  champion: 62294,
  hero: 62295,
  myth: 62296,
} as const;

const UPGRADE_TRACK_IDS = {
  mythic: [12801, 12802, 12803, 12804, 12805, 12806],
  heroic: [12793, 12794, 12795, 12796, 12797, 12798],
  normal: [12785, 12786, 12787, 12788, 12789, 12790],
  raidFinder: [12777, 12778, 12779, 12780, 12781, 12782],
  worldAdvanced: [12769, 12770, 12771, 12772, 12773, 12774],
} as const;

const UPGRADE_STEPS_BY_BONUS_ID = new Map<number, { current: number; max: number }>(
  Object.values(UPGRADE_TRACK_IDS).flatMap((ids) =>
    ids.map((id, index) => [id, { current: index + 1, max: ids.length }] as const)
  )
);

const ALWAYS_ENCHANTABLE_SLOTS = new Set([
  'HEAD',
  'SHOULDER',
  'CHEST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'MAIN_HAND',
]);

// Class tier sets only ever occupy these five armor slots.
// Other item sets (e.g. ring pairs like "Voidlight Bindings") use non-tier slots
// and must not be counted as tier pieces.
const TIER_SET_SLOTS = new Set(['HEAD', 'SHOULDER', 'CHEST', 'HANDS', 'LEGS']);

// Season 16 Great Vault ilvl reward by keystone level.
// Levels > 10 are capped to 10; levels < 2 are not valid keystone levels
// from Raider.IO (which only returns actual keystone runs).
const GREAT_VAULT_DUNGEON_ILVL = new Map<number, number>([
  [10, 272], [9, 269], [8, 269], [7, 269], [6, 266],
  [5, 263],  [4, 263], [3, 259], [2, 259],
]);

const GREAT_VAULT_RAID_ILVL_BY_MODE: Record<'M' | 'H' | 'N' | 'L', number> = {
  M: 272,
  H: 266,
  N: 259,
  L: 252,
};

const GREAT_VAULT_RAID_KILLS_NEEDED = [2, 4, 6] as const;

// Blizzard achievement stat IDs for all Season 16 tracked Mythic+ dungeons.
// The `quantity` field is the lifetime completion count per dungeon.
// Pit of Saron has no stat ID (mythic_id = 0) so it is omitted.
const SEASON_16_MYTHIC_DUNGEON_STAT_IDS = new Set([
  61652, 61217, 61275, 41295, 61655, 61658, 61661, 61513, // expansion dungeons
  16088, 12613, 10195,                                      // legacy keystones
]);

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

// Look up Great Vault ilvl for a keystone level at the given sorted-desc slot index.
function computeVaultIlvl(sortedLevels: number[], slotIndex: 0 | 3 | 7): number | null {
  const level = sortedLevels[slotIndex];
  if (level === undefined) return null;
  const clamped = Math.min(level, 10);
  return GREAT_VAULT_DUNGEON_ILVL.get(clamped) ?? null;
}

function computeVaultIlvlFromLevel(level: number | null): number | null {
  if (level === null || !Number.isFinite(level) || level < 2) return null;
  const clamped = Math.min(Math.floor(level), 10);
  return GREAT_VAULT_DUNGEON_ILVL.get(clamped) ?? null;
}

/** Merge newly-seen RIO runs into the persistent keystones table (INSERT OR IGNORE). */
async function mergeKeystoneRuns(
  db: D1Database,
  blizzardCharId: number,
  runs: KeystoneRun[]
): Promise<void> {
  if (runs.length === 0) return;
  // D1 batch limit; process in chunks of 50
  const CHUNK = 50;
  for (let i = 0; i < runs.length; i += CHUNK) {
    const chunk = runs.slice(i, i + CHUNK);
    const statements = chunk.map((run) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO raider_keystones (blizzard_char_id, completed_ts, dungeon_id, keystone_level)
           VALUES (?, ?, ?, ?)`
        )
        .bind(blizzardCharId, run.completedTs, run.dungeonId ?? null, run.keystoneLevel ?? null)
    );
    await db.batch(statements);
  }
}

/** Count runs in the keystones table for the current week and full season. */
async function countKeystoneRuns(
  db: D1Database,
  blizzardCharId: number,
  weeklyResetTs: number
): Promise<{ weekly: number; prevWeekly: number; season: number; weeklyKeyLevels: number[] }> {
  const previousWeeklyResetTs = weeklyResetTs - WEEK_SECONDS;
  const [weeklyResult, previousWeeklyResult, seasonResult, keyLevelsResult] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM raider_keystones WHERE blizzard_char_id = ? AND completed_ts >= ?`)
      .bind(blizzardCharId, weeklyResetTs)
      .first<{ cnt: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM raider_keystones
         WHERE blizzard_char_id = ? AND completed_ts >= ? AND completed_ts < ?`
      )
      .bind(blizzardCharId, previousWeeklyResetTs, weeklyResetTs)
      .first<{ cnt: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM raider_keystones WHERE blizzard_char_id = ? AND completed_ts >= ?`)
      .bind(blizzardCharId, MIDNIGHT_SEASON_1_START_TIMESTAMP)
      .first<{ cnt: number }>(),
    db
      .prepare(
        `SELECT keystone_level FROM raider_keystones
         WHERE blizzard_char_id = ? AND completed_ts >= ? AND keystone_level IS NOT NULL
         ORDER BY keystone_level DESC`
      )
      .bind(blizzardCharId, weeklyResetTs)
      .all<{ keystone_level: number }>(),
  ]);

  return {
    weekly: weeklyResult?.cnt ?? 0,
    prevWeekly: previousWeeklyResult?.cnt ?? 0,
    season: seasonResult?.cnt ?? 0,
    weeklyKeyLevels: (keyLevelsResult.results ?? []).map((r) => r.keystone_level),
  };
}



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
  adventurer_crests: number | null;
  veteran_crests: number | null;
  champion_crests: number | null;
  hero_crests: number | null;
  myth_crests: number | null;
  mythic_plus_run_count: number | null;
  mythic_plus_weekly_runs: number | null;
  mythic_plus_prev_weekly_runs: number | null;
  mythic_plus_season_runs: number | null;
  mythic_plus_vault_ilvl_1: number | null;
  mythic_plus_vault_ilvl_2: number | null;
  mythic_plus_vault_ilvl_3: number | null;
  world_vault_weekly_objectives: number | null;
  total_upgrades_missing: number | null;
  raid_progress_raid_name: string | null;
  raid_progress_label: string | null;
  raid_progress_kills: number | null;
  raid_progress_total: number | null;
  details_synced_at: number | null;
  avg_30d_socketed_gems: number | null;
  avg_30d_total_sockets: number | null;
  avg_30d_enchanted_slots: number | null;
  avg_30d_enchantable_slots: number | null;
}

function computeDisplayedMythicPlusTotal(row: Pick<CachedRaiderRow, 'mythic_plus_run_count' | 'mythic_plus_weekly_runs' | 'mythic_plus_season_runs'>): number | null {
  // mythic_plus_season_runs is now the full season total (current week included).
  // mythic_plus_weekly_runs separately tracks just this week for Great Vault display.
  if (row.mythic_plus_season_runs !== null) {
    return row.mythic_plus_season_runs;
  }
  if (row.mythic_plus_weekly_runs !== null) {
    return row.mythic_plus_weekly_runs;
  }
  return null;
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

interface BlizzardAchievementStatisticsResponse {
  categories?: BlizzardAchievementStatisticsCategory[];
}

interface BlizzardAchievementStatisticsCategory {
  name?: string;
  statistics?: BlizzardAchievementStatistic[];
  sub_categories?: BlizzardAchievementStatisticsCategory[];
}

interface BlizzardAchievementStatistic {
  id?: number;
  quantity?: number;
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
      last_kill_timestamp?: number;
    }>;
  };
}

type RaidModeCode = 'L' | 'N' | 'H' | 'M';

interface BlizzardEquipmentResponse {
  equipped_items?: BlizzardEquippedItem[];
}

interface BlizzardEquippedItem {
  slot?: {
    type?: string;
  };
  name?: string;
  quality?: {
    type?: string;
  };
  level?: {
    value?: number;
  };
  item?: {
    id?: number;
  };
  sockets?: Array<{
    item?: {
      id?: number;
      name?: string;
    };
    media?: unknown;
    display_string?: string;
  }>;
  enchantments?: Array<{
    display_string?: string;
  }>;
  stats?: BlizzardItemStat[];
  bonus_list?: number[];
  item_set?: unknown;
  set?: unknown;
}

interface BlizzardItemStat {
  type?: {
    type?: string;
    name?: string;
  };
  value?: number;
  display?: {
    display_string?: string;
  };
  display_string?: string;
}

export interface RaiderGearItem {
  slotKey: string;
  slotLabel: string;
  itemName: string | null;
  itemId: number | null;
  itemLevel: number | null;
  quality: string | null;
  qualityColor: string;
  enchantments: string[];
  gems: string[];
  stats: string[];
  socketsFilled: number;
  socketsTotal: number;
  canEnchant: boolean;
  canGem: boolean;
}

const GEAR_SLOT_ORDER: string[] = [
  'HEAD',
  'NECK',
  'SHOULDER',
  'BACK',
  'CHEST',
  'WRIST',
  'HANDS',
  'WAIST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'TRINKET_1',
  'TRINKET_2',
  'MAIN_HAND',
  'OFF_HAND',
];

const GEAR_SLOT_LABELS: Record<string, string> = {
  HEAD: 'Head',
  NECK: 'Neck',
  SHOULDER: 'Shoulder',
  BACK: 'Back',
  CHEST: 'Chest',
  SHIRT: 'Shirt',
  TABARD: 'Tabard',
  WRIST: 'Wrist',
  HANDS: 'Hands',
  WAIST: 'Waist',
  LEGS: 'Legs',
  FEET: 'Feet',
  FINGER_1: 'Finger 1',
  FINGER_2: 'Finger 2',
  TRINKET_1: 'Trinket 1',
  TRINKET_2: 'Trinket 2',
  MAIN_HAND: 'Main Hand',
  OFF_HAND: 'Off Hand',
};

const ITEM_QUALITY_COLORS: Record<string, string> = {
  POOR: '#9d9d9d',
  COMMON: '#ffffff',
  UNCOMMON: '#1eff00',
  RARE: '#0070dd',
  EPIC: '#a335ee',
  LEGENDARY: '#ff8000',
  ARTIFACT: '#e6cc80',
  HEIRLOOM: '#00ccff',
};

function gearSlotLabel(slotType: string): string {
  return GEAR_SLOT_LABELS[slotType] ?? slotType.replace(/_/g, ' ');
}

function itemQualityColor(qualityType: string | null | undefined): string {
  if (!qualityType) return '#d7e7f3';
  return ITEM_QUALITY_COLORS[qualityType.toUpperCase()] ?? '#d7e7f3';
}

function formatItemStat(stat: BlizzardItemStat): string | null {
  const displayString = (stat.display?.display_string ?? stat.display_string ?? '').trim();
  if (displayString) return displayString;

  const statName = (stat.type?.name ?? stat.type?.type ?? '').trim().replace(/_/g, ' ');
  const statValue = Number(stat.value ?? 0);
  if (!statName || !Number.isFinite(statValue) || statValue === 0) return null;

  return `${statValue > 0 ? '+' : ''}${statValue} ${statName}`;
}

function formatEnchantmentLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Normalize to a single line first.
  let normalized = trimmed
    .split(/[\r\n\u2028\u2029]+/)[0]
    ?.replace(/\s+/g, ' ')
    .trim() ?? trimmed;

  // Common Blizzard prefixes seen in item tooltips.
  normalized = normalized
    .replace(/^Enchanted:\s*/i, '')
    .replace(/^Enchant\s+(?:Ring|Rings|Weapon|Weapons|Chest|Feet|Boots|Legs|Shoulders|Shoulder|Head|Main Hand|Off Hand)\s*[-:]+\s*/i, '')
    .replace(/^Enchant\s+/i, '')
    .trim();

  // If a slot prefix remains (e.g. "Shoulders - Authority of Storms"), keep only the right side.
  if (normalized.includes(' - ')) {
    const rhs = normalized.split(' - ').pop()?.trim();
    if (rhs) normalized = rhs;
  }

  // Drop trailing metadata and effect descriptions.
  normalized = normalized
    .split(/\s+(?:Requires|Quality|Tier|Rank)\b/i)[0]
    .split(/\s+(?:and\s+lasts|and\s+adds?|and\s+grants?|adds?|grants?|increases?|improves?|provides?|reduces?|restores?)\b/i)[0]
    .split('|')[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[.;:,\s]+$/g, '')
    .trim();

  return normalized || trimmed;
}

function itemLooksLikeWeapon(item: BlizzardEquippedItem | null | undefined): boolean {
  if (!item) return false;

  return (item.stats ?? []).some((stat) => {
    const typeName = String(stat.type?.type ?? stat.type?.name ?? '').toUpperCase();
    const display = String(stat.display?.display_string ?? stat.display_string ?? '').toUpperCase();
    return (
      typeName.includes('DAMAGE') ||
      typeName.includes('DPS') ||
      typeName.includes('SPEED') ||
      display.includes('DAMAGE PER SECOND') ||
      display.includes('DAMAGE') ||
      display.includes('SPEED')
    );
  });
}

function isEnchantableItem(slotType: string, item: BlizzardEquippedItem | null | undefined): boolean {
  if (ALWAYS_ENCHANTABLE_SLOTS.has(slotType)) return true;
  if (slotType === 'OFF_HAND') return itemLooksLikeWeapon(item);
  return false;
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
  adventurerCrests: number | null;
  veteranCrests: number | null;
  championCrests: number | null;
  heroCrests: number | null;
  mythCrests: number | null;
  mythicPlusRunCount: number | null;
  mythicPlusWeeklyRuns: number | null;
  mythicPlusPrevWeeklyRuns: number | null;
  mythicPlusSeasonRuns: number | null;
  mythicPlusVaultIlvl1: number | null;
  mythicPlusVaultIlvl2: number | null;
  mythicPlusVaultIlvl3: number | null;
  mythicPlusLifetimeTotal: number | null;
  mythicPlusAllRuns: KeystoneRun[];
  worldVaultWeeklyObjectives: number | null;
  worldVaultLifetimeObjectives: number | null;
  totalUpgradesMissing: number | null;
  raidProgressRaidName: string | null;
  raidProgressLabel: string | null;
  raidProgressKills: number | null;
  raidProgressTotal: number | null;
  avg30dSocketedGems: number | null;
  avg30dTotalSockets: number | null;
  avg30dEnchantedSlots: number | null;
  avg30dEnchantableSlots: number | null;
  singleTargetDps: number | null;
  singleTargetUpdatedAt: number | null;
  droptimizerUpdatedAt: number | null;
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

function toNonEmptyString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeTeamNames(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function extractCrestCounts(stats: BlizzardAchievementStatisticsResponse | null): {
  adventurerCrests: number | null;
  veteranCrests: number | null;
  championCrests: number | null;
  heroCrests: number | null;
  mythCrests: number | null;
} {
  const characterStats = stats?.categories?.find((category) => category.name === 'Character')?.statistics ?? [];
  const byId = new Map(characterStats.map((stat) => [Number(stat.id ?? -1), Number(stat.quantity ?? 0)]));
  const read = (id: number) => (byId.has(id) ? byId.get(id) ?? 0 : null);

  return {
    adventurerCrests: read(CREST_STAT_IDS.adventurer),
    veteranCrests: read(CREST_STAT_IDS.veteran),
    championCrests: read(CREST_STAT_IDS.champion),
    heroCrests: read(CREST_STAT_IDS.hero),
    mythCrests: read(CREST_STAT_IDS.myth),
  };
}

// Sums the lifetime `quantity` for all Season 16 tracked dungeons across every
// achievement statistics category. Used to compute weekly run deltas.
function extractMythicPlusLifetimeTotal(stats: BlizzardAchievementStatisticsResponse | null): number {
  const collectStatistics = (categories: BlizzardAchievementStatisticsCategory[] | undefined): BlizzardAchievementStatistic[] => {
    if (!categories || categories.length === 0) return [];

    const collected: BlizzardAchievementStatistic[] = [];
    for (const category of categories) {
      collected.push(...(category.statistics ?? []));
      if (category.sub_categories?.length) {
        collected.push(...collectStatistics(category.sub_categories));
      }
    }

    return collected;
  };

  let total = 0;
  for (const stat of collectStatistics(stats?.categories)) {
    if (stat.id !== undefined && SEASON_16_MYTHIC_DUNGEON_STAT_IDS.has(stat.id)) {
      total += Number(stat.quantity ?? 0);
    }
  }
  return total;
}

function extractDelvesLifetimeTotal(stats: BlizzardAchievementStatisticsResponse | null): number | null {
  const collectStatistics = (categories: BlizzardAchievementStatisticsCategory[] | undefined): BlizzardAchievementStatistic[] => {
    if (!categories || categories.length === 0) return [];

    const collected: BlizzardAchievementStatistic[] = [];
    for (const category of categories) {
      collected.push(...(category.statistics ?? []));
      if (category.sub_categories?.length) {
        collected.push(...collectStatistics(category.sub_categories));
      }
    }

    return collected;
  };

  const stat = collectStatistics(stats?.categories).find((entry) => Number(entry.id ?? -1) === DELVES_TOTAL_STAT_ID);
  if (!stat) return null;

  const total = Number(stat.quantity ?? NaN);
  if (!Number.isFinite(total)) return null;
  return Math.max(0, Math.floor(total));
}

function countTierPieces(items: BlizzardEquippedItem[]): number {
  return items.reduce((count, item) => {
    const slotType = item.slot?.type ?? '';
    return TIER_SET_SLOTS.has(slotType) && (item.item_set || item.set) ? count + 1 : count;
  }, 0);
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
    if (!isEnchantableItem(slotType, item)) continue;

    total += 1;
    if ((item.enchantments?.length ?? 0) > 0) {
      filled += 1;
    }
  }

  return { filled, total };
}

function computeTotalUpgradesMissing(items: BlizzardEquippedItem[]): number {
  let totalMissing = 0;

  for (const item of items) {
    const bonusIds = item.bonus_list ?? [];
    const matchedUpgradeStep = bonusIds
      .map((id) => UPGRADE_STEPS_BY_BONUS_ID.get(id))
      .find((entry): entry is { current: number; max: number } => Boolean(entry));

    if (!matchedUpgradeStep) continue;
    totalMissing += Math.max(0, matchedUpgradeStep.max - matchedUpgradeStep.current);
  }

  return totalMissing;
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

  const weeklyResetTs = getUsWeeklyResetTimestamp();
  const weeklyRaidBossBestByKey = new Map<string, RaidModeCode>();
  const raidModeSortOrder: RaidModeCode[] = ['M', 'H', 'N', 'L'];

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

        // Track weekly raid kill quality per boss key so Great Vault slots can
        // represent the actual highest difficulty kills this week.
        for (const [encounterIndex, encounter] of (mode.progress?.encounters ?? []).entries()) {
          const completedTsRaw = Number(encounter?.last_kill_timestamp ?? 0);
          if (!Number.isFinite(completedTsRaw) || completedTsRaw <= 0) continue;

          const completedTs = completedTsRaw > 10_000_000_000
            ? Math.floor(completedTsRaw / 1000)
            : Math.floor(completedTsRaw);
          if (completedTs < weeklyResetTs) continue;

          const bossKey = `${raid.code}:${encounterIndex}`;
          const existing = weeklyRaidBossBestByKey.get(bossKey);
          if (!existing || raidModeSortOrder.indexOf(modeCode) < raidModeSortOrder.indexOf(existing)) {
            weeklyRaidBossBestByKey.set(bossKey, modeCode);
          }
        }
      }
    }
  }

  const weeklyRaidBossModes = [...weeklyRaidBossBestByKey.values()].sort(
    (a, b) => raidModeSortOrder.indexOf(a) - raidModeSortOrder.indexOf(b)
  );

  const raidVaultOptions = GREAT_VAULT_RAID_KILLS_NEEDED.map((killsNeeded) => {
    const mode = weeklyRaidBossModes[killsNeeded - 1];
    return mode ? GREAT_VAULT_RAID_ILVL_BY_MODE[mode] : null;
  });

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
    vaultRaid: {
      weeklyBossKills: weeklyRaidBossModes.length,
      options: raidVaultOptions,
    },
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

function parseRaidVaultPayload(label: string | null): { weeklyBossKills: number; options: Array<number | null> } | null {
  if (!label) return null;

  try {
    const parsed = JSON.parse(label) as { vaultRaid?: { weeklyBossKills?: unknown; options?: unknown } };
    if (!parsed?.vaultRaid || !Array.isArray(parsed.vaultRaid.options)) return null;

    const options = parsed.vaultRaid.options
      .slice(0, 3)
      .map((value) => {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) && asNumber > 0 ? Math.floor(asNumber) : null;
      });

    while (options.length < 3) options.push(null);

    const weeklyBossKillsRaw = Number(parsed.vaultRaid.weeklyBossKills ?? 0);
    const weeklyBossKills = Number.isFinite(weeklyBossKillsRaw) ? Math.max(0, Math.floor(weeklyBossKillsRaw)) : 0;

    return { weeklyBossKills, options };
  } catch {
    return null;
  }
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
    adventurerCrests: null,
    veteranCrests: null,
    championCrests: null,
    heroCrests: null,
    mythCrests: null,
    mythicPlusRunCount: null,
    mythicPlusWeeklyRuns: null,
    mythicPlusPrevWeeklyRuns: null,
    mythicPlusSeasonRuns: null,
    mythicPlusVaultIlvl1: null,
    mythicPlusVaultIlvl2: null,
    mythicPlusVaultIlvl3: null,
    mythicPlusLifetimeTotal: null,
    mythicPlusAllRuns: [],
    worldVaultWeeklyObjectives: null,
    worldVaultLifetimeObjectives: null,
    totalUpgradesMissing: null,
    raidProgressRaidName: null,
    raidProgressLabel: null,
    raidProgressKills: null,
    raidProgressTotal: null,
    avg30dSocketedGems: null,
    avg30dTotalSockets: null,
    avg30dEnchantedSlots: null,
    avg30dEnchantableSlots: null,
    singleTargetDps: null,
    singleTargetUpdatedAt: null,
    droptimizerUpdatedAt: null,
  };

  const accessToken = await getBlizzardAppAccessToken();
  if (!accessToken) {
    return { ...baseRecord, authState: 'unavailable' };
  }

  const [summary, equipment, mythicProfile, achievementStatistics, raidEncounters, mythicPlusRunCount] = await Promise.all([
    fetchBlizzardJsonWithRetry<BlizzardSummaryResponse>(buildCharacterUrl(row.realm_slug, row.name), accessToken),
    fetchBlizzardJsonWithRetry<BlizzardEquipmentResponse>(buildCharacterUrl(row.realm_slug, row.name, '/equipment'), accessToken),
    fetchBlizzardJsonWithRetry<BlizzardMythicProfileResponse>(
      buildCharacterUrl(row.realm_slug, row.name, '/mythic-keystone-profile'),
      accessToken
    ),
    fetchBlizzardJsonWithRetry<BlizzardAchievementStatisticsResponse>(
      buildCharacterUrl(row.realm_slug, row.name, '/achievements/statistics'),
      accessToken
    ),
    fetchBlizzardJsonWithRetry<BlizzardRaidEncountersResponse>(
      buildCharacterUrl(row.realm_slug, row.name, '/encounters/raids'),
      accessToken
    ),
    getCharacterMythicPlusRunCounts(row.realm_slug, row.name).catch(() => ({ total: null, thisWeek: null, lastWeek: null, thisWeekKeyLevels: [] as number[] })),
  ]);

  if (!summary || !equipment) {
    return { ...baseRecord, authState: 'unavailable' };
  }

  const equippedItems = equipment.equipped_items ?? [];
  const socketCounts = countSockets(equippedItems);
  const enchantCounts = countEnchants(equippedItems);
  const crestCounts = extractCrestCounts(achievementStatistics);
  const mythicPlusLifetimeTotal = extractMythicPlusLifetimeTotal(achievementStatistics);
  const delvesLifetimeTotal = extractDelvesLifetimeTotal(achievementStatistics);
  const raidProgress = extractRaidProgress(raidEncounters, raidProgressTarget);
  const totalUpgradesMissing = computeTotalUpgradesMissing(equippedItems);

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
    adventurerCrests: crestCounts.adventurerCrests,
    veteranCrests: crestCounts.veteranCrests,
    championCrests: crestCounts.championCrests,
    heroCrests: crestCounts.heroCrests,
    mythCrests: crestCounts.mythCrests,
    mythicPlusRunCount: mythicPlusLifetimeTotal,
    mythicPlusWeeklyRuns: mythicPlusRunCount.thisWeek,
    mythicPlusPrevWeeklyRuns: mythicPlusRunCount.lastWeek,
    mythicPlusSeasonRuns: null, // computed in update loop from keystones table
    mythicPlusVaultIlvl1: null, // computed in update loop from keystones table
    mythicPlusVaultIlvl2: null, // computed in update loop from keystones table
    mythicPlusVaultIlvl3: null, // computed in update loop from keystones table
    mythicPlusLifetimeTotal,
    mythicPlusAllRuns: mythicPlusRunCount.allRuns,
    worldVaultWeeklyObjectives: null,
    worldVaultLifetimeObjectives: delvesLifetimeTotal,
    totalUpgradesMissing,
    raidProgressRaidName: raidProgress.raidName,
    raidProgressLabel: raidProgress.label,
    raidProgressKills: raidProgress.kills,
    raidProgressTotal: raidProgress.total,
    avg30dSocketedGems: null,
    avg30dTotalSockets: null,
    avg30dEnchantedSlots: null,
    avg30dEnchantableSlots: null,
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
          adventurer_crests,
          veteran_crests,
          champion_crests,
          hero_crests,
          myth_crests,
          mythic_plus_run_count,
          mythic_plus_weekly_runs,
          mythic_plus_prev_weekly_runs,
          mythic_plus_season_runs,
          mythic_plus_vault_ilvl_1,
          mythic_plus_vault_ilvl_2,
          mythic_plus_vault_ilvl_3,
          world_vault_weekly_objectives,
          total_upgrades_missing,
          raid_progress_raid_name,
          raid_progress_label,
          raid_progress_kills,
          raid_progress_total,
          details_synced_at,
          avg_30d_socketed_gems,
          avg_30d_total_sockets,
          avg_30d_enchanted_slots,
          avg_30d_enchantable_slots
       FROM raider_metrics_cache
       ORDER BY class_name ASC, name ASC`
    )
    .all<CachedRaiderRow>();

  return ((result.results ?? []) as CachedRaiderRow[]).map((row) => ({
    blizzardCharId: row.blizzard_char_id,
    name: toNonEmptyString(row.name, `Unknown-${row.blizzard_char_id}`),
    realm: toNonEmptyString(row.realm, 'Unknown Realm'),
    realmSlug: toNonEmptyString(row.realm_slug, 'unknown-realm'),
    className: toNonEmptyString(row.class_name, 'Unknown'),
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
    adventurerCrests: row.adventurer_crests,
    veteranCrests: row.veteran_crests,
    championCrests: row.champion_crests,
    heroCrests: row.hero_crests,
    mythCrests: row.myth_crests,
    mythicPlusRunCount: computeDisplayedMythicPlusTotal(row),
    mythicPlusWeeklyRuns: row.mythic_plus_weekly_runs,
    mythicPlusPrevWeeklyRuns: row.mythic_plus_prev_weekly_runs,
    mythicPlusSeasonRuns: row.mythic_plus_season_runs,
    mythicPlusVaultIlvl1: row.mythic_plus_vault_ilvl_1,
    mythicPlusVaultIlvl2: row.mythic_plus_vault_ilvl_2,
    mythicPlusVaultIlvl3: row.mythic_plus_vault_ilvl_3,
    mythicPlusLifetimeTotal: row.mythic_plus_run_count,
    worldVaultWeeklyObjectives: row.world_vault_weekly_objectives,
    worldVaultLifetimeObjectives: null,
    totalUpgradesMissing: row.total_upgrades_missing,
    raidProgressRaidName: row.raid_progress_raid_name,
    raidProgressLabel: row.raid_progress_label,
    raidProgressKills: row.raid_progress_kills,
    raidProgressTotal: row.raid_progress_total,
    avg30dSocketedGems: row.avg_30d_socketed_gems,
    avg30dTotalSockets: row.avg_30d_total_sockets,
    avg30dEnchantedSlots: row.avg_30d_enchanted_slots,
    avg30dEnchantableSlots: row.avg_30d_enchantable_slots,
    singleTargetDps: null,
    singleTargetUpdatedAt: null,
    droptimizerUpdatedAt: null,
  }));
}

async function recordPreparednessHistory(db: D1Database, raider: RaiderRecord, now: number): Promise<void> {
  if (raider.socketedGems === null || raider.totalSockets === null ||
      raider.enchantedSlots === null || raider.enchantableSlots === null) {
    return;
  }

  await db
    .prepare(
      `DELETE FROM raider_preparedness_history
       WHERE blizzard_char_id = ?
         AND date(recorded_at, 'unixepoch') = date(?, 'unixepoch')`
    )
    .bind(raider.blizzardCharId, now)
    .run();

  await db
    .prepare(
      `INSERT INTO raider_preparedness_history (
        blizzard_char_id,
        recorded_at,
        socketed_gems,
        total_sockets,
        enchanted_slots,
        enchantable_slots
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      raider.blizzardCharId,
      now,
      raider.socketedGems,
      raider.totalSockets,
      raider.enchantedSlots,
      raider.enchantableSlots
    )
    .run();
}

async function calculateAndUpdatePreparednessAverages(db: D1Database, charId: number, now: number): Promise<void> {
  const cutoff = now - PREPAREDNESS_HISTORY_WINDOW_SECONDS;

  const averageResult = await db
    .prepare(
      `WITH latest_per_day AS (
         SELECT MAX(recorded_at) AS recorded_at
         FROM raider_preparedness_history
         WHERE blizzard_char_id = ?
           AND recorded_at >= ?
         GROUP BY date(recorded_at, 'unixepoch')
       )
       SELECT
         AVG(CAST(h.socketed_gems AS REAL)) as avg_socketed_gems,
         AVG(CAST(h.total_sockets AS REAL)) as avg_total_sockets,
         AVG(CAST(h.enchanted_slots AS REAL)) as avg_enchanted_slots,
         AVG(CAST(h.enchantable_slots AS REAL)) as avg_enchantable_slots
       FROM raider_preparedness_history h
       JOIN latest_per_day d ON d.recorded_at = h.recorded_at
       WHERE h.blizzard_char_id = ?`
    )
    .bind(charId, cutoff, charId)
    .first<{
      avg_socketed_gems: number | null;
      avg_total_sockets: number | null;
      avg_enchanted_slots: number | null;
      avg_enchantable_slots: number | null;
    }>();

  await db
    .prepare(
      `UPDATE raider_metrics_cache
       SET avg_30d_socketed_gems = ?,
           avg_30d_total_sockets = ?,
           avg_30d_enchanted_slots = ?,
           avg_30d_enchantable_slots = ?,
           preparedness_history_synced_at = ?
       WHERE blizzard_char_id = ?`
    )
    .bind(
      averageResult?.avg_socketed_gems ?? null,
      averageResult?.avg_total_sockets ?? null,
      averageResult?.avg_enchanted_slots ?? null,
      averageResult?.avg_enchantable_slots ?? null,
      now,
      charId
    )
    .run();
}

async function prunePreparednessHistory(db: D1Database, cutoff: number): Promise<void> {
  await db
    .prepare(`DELETE FROM raider_preparedness_history WHERE recorded_at < ?`)
    .bind(cutoff)
    .run();
}

async function recordProgressionHistory(db: D1Database, raider: RaiderRecord, now: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM raider_progression_history
       WHERE blizzard_char_id = ?
         AND date(recorded_at, 'unixepoch') = date(?, 'unixepoch')`
    )
    .bind(raider.blizzardCharId, now)
    .run();

  await db
    .prepare(
      `INSERT INTO raider_progression_history (
        blizzard_char_id,
        recorded_at,
        equipped_item_level,
        mythic_score,
        adventurer_crests,
        veteran_crests,
        champion_crests,
        hero_crests,
        myth_crests,
        total_upgrades_missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      raider.blizzardCharId,
      now,
      raider.equippedItemLevel,
      raider.mythicScore,
      raider.adventurerCrests,
      raider.veteranCrests,
      raider.championCrests,
      raider.heroCrests,
      raider.mythCrests,
      raider.totalUpgradesMissing
    )
    .run();
}

async function recordVaultHistorySnapshot(
  db: D1Database,
  raider: RaiderRecord,
  now: number,
  worldWeeklyObjectivesOverride?: number | null
): Promise<void> {
  const weekStartTs = getUsWeeklyResetTimestamp();
  const weekEndTs = weekStartTs + WEEK_SECONDS;

  const raidVault = parseRaidVaultPayload(raider.raidProgressLabel);
  const raidSlot1 = raidVault?.options[0] ?? null;
  const raidSlot2 = raidVault?.options[1] ?? null;
  const raidSlot3 = raidVault?.options[2] ?? null;
  const raidSlotsFilled = [raidSlot1, raidSlot2, raidSlot3].filter((slot) => slot !== null).length;

  const dungeonSlot1 = raider.mythicPlusVaultIlvl1;
  const dungeonSlot2 = raider.mythicPlusVaultIlvl2;
  const dungeonSlot3 = raider.mythicPlusVaultIlvl3;
  const dungeonSlotsFilled = [dungeonSlot1, dungeonSlot2, dungeonSlot3].filter((slot) => slot !== null).length;

  const worldWeeklyObjectives = worldWeeklyObjectivesOverride ?? raider.worldVaultWeeklyObjectives;
  const worldSlotsFilled = worldWeeklyObjectives === null
    ? 0
    : [2, 4, 8].filter((required) => worldWeeklyObjectives >= required).length;

  const totalSlotsFilled = raidSlotsFilled + dungeonSlotsFilled + worldSlotsFilled;

  await db
    .prepare(
      `INSERT INTO raider_vault_history (
         blizzard_char_id,
         week_start_ts,
         week_end_ts,
         snapshot_ts,
         raid_weekly_boss_kills,
         raid_slot_1_ilvl,
         raid_slot_2_ilvl,
         raid_slot_3_ilvl,
         dungeon_slot_1_ilvl,
         dungeon_slot_2_ilvl,
         dungeon_slot_3_ilvl,
         world_weekly_objectives,
         raid_slots_filled,
         dungeon_slots_filled,
         world_slots_filled,
         total_slots_filled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(blizzard_char_id, week_start_ts) DO UPDATE SET
         snapshot_ts = excluded.snapshot_ts,
         raid_weekly_boss_kills = CASE
           WHEN excluded.raid_weekly_boss_kills IS NULL THEN raider_vault_history.raid_weekly_boss_kills
           WHEN raider_vault_history.raid_weekly_boss_kills IS NULL THEN excluded.raid_weekly_boss_kills
           ELSE MAX(raider_vault_history.raid_weekly_boss_kills, excluded.raid_weekly_boss_kills)
         END,
         raid_slot_1_ilvl = CASE
           WHEN excluded.raid_slot_1_ilvl IS NULL THEN raider_vault_history.raid_slot_1_ilvl
           WHEN raider_vault_history.raid_slot_1_ilvl IS NULL THEN excluded.raid_slot_1_ilvl
           ELSE MAX(raider_vault_history.raid_slot_1_ilvl, excluded.raid_slot_1_ilvl)
         END,
         raid_slot_2_ilvl = CASE
           WHEN excluded.raid_slot_2_ilvl IS NULL THEN raider_vault_history.raid_slot_2_ilvl
           WHEN raider_vault_history.raid_slot_2_ilvl IS NULL THEN excluded.raid_slot_2_ilvl
           ELSE MAX(raider_vault_history.raid_slot_2_ilvl, excluded.raid_slot_2_ilvl)
         END,
         raid_slot_3_ilvl = CASE
           WHEN excluded.raid_slot_3_ilvl IS NULL THEN raider_vault_history.raid_slot_3_ilvl
           WHEN raider_vault_history.raid_slot_3_ilvl IS NULL THEN excluded.raid_slot_3_ilvl
           ELSE MAX(raider_vault_history.raid_slot_3_ilvl, excluded.raid_slot_3_ilvl)
         END,
         dungeon_slot_1_ilvl = CASE
           WHEN excluded.dungeon_slot_1_ilvl IS NULL THEN raider_vault_history.dungeon_slot_1_ilvl
           WHEN raider_vault_history.dungeon_slot_1_ilvl IS NULL THEN excluded.dungeon_slot_1_ilvl
           ELSE MAX(raider_vault_history.dungeon_slot_1_ilvl, excluded.dungeon_slot_1_ilvl)
         END,
         dungeon_slot_2_ilvl = CASE
           WHEN excluded.dungeon_slot_2_ilvl IS NULL THEN raider_vault_history.dungeon_slot_2_ilvl
           WHEN raider_vault_history.dungeon_slot_2_ilvl IS NULL THEN excluded.dungeon_slot_2_ilvl
           ELSE MAX(raider_vault_history.dungeon_slot_2_ilvl, excluded.dungeon_slot_2_ilvl)
         END,
         dungeon_slot_3_ilvl = CASE
           WHEN excluded.dungeon_slot_3_ilvl IS NULL THEN raider_vault_history.dungeon_slot_3_ilvl
           WHEN raider_vault_history.dungeon_slot_3_ilvl IS NULL THEN excluded.dungeon_slot_3_ilvl
           ELSE MAX(raider_vault_history.dungeon_slot_3_ilvl, excluded.dungeon_slot_3_ilvl)
         END,
         world_weekly_objectives = CASE
           WHEN excluded.world_weekly_objectives IS NULL THEN raider_vault_history.world_weekly_objectives
           WHEN raider_vault_history.world_weekly_objectives IS NULL THEN excluded.world_weekly_objectives
           ELSE MAX(raider_vault_history.world_weekly_objectives, excluded.world_weekly_objectives)
         END,
         raid_slots_filled = MAX(raider_vault_history.raid_slots_filled, excluded.raid_slots_filled),
         dungeon_slots_filled = MAX(raider_vault_history.dungeon_slots_filled, excluded.dungeon_slots_filled),
         world_slots_filled = MAX(raider_vault_history.world_slots_filled, excluded.world_slots_filled),
         total_slots_filled = MAX(raider_vault_history.total_slots_filled, excluded.total_slots_filled)`
    )
    .bind(
      raider.blizzardCharId,
      weekStartTs,
      weekEndTs,
      now,
      raidVault?.weeklyBossKills ?? null,
      raidSlot1,
      raidSlot2,
      raidSlot3,
      dungeonSlot1,
      dungeonSlot2,
      dungeonSlot3,
      worldWeeklyObjectives,
      raidSlotsFilled,
      dungeonSlotsFilled,
      worldSlotsFilled,
      totalSlotsFilled
    )
    .run();
}

async function pruneProgressionHistory(db: D1Database, cutoff: number): Promise<void> {
  await db
    .prepare(`DELETE FROM raider_progression_history WHERE recorded_at < ?`)
    .bind(cutoff)
    .run();
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
  weeklyResetTs: number,
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
           OR rmc.adventurer_crests IS NULL
           OR rmc.veteran_crests IS NULL
           OR rmc.champion_crests IS NULL
           OR rmc.hero_crests IS NULL
           OR rmc.myth_crests IS NULL
           OR rmc.total_upgrades_missing IS NULL
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
        weeklyResetTs,
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
  const weeklyResetTs = getUsWeeklyResetTimestamp();
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
        weeklyResetTs,
        effectiveRaidProgressTierId
      );
  const detailResults = await mapWithConcurrency(
    detailCandidates,
    REQUEST_CONCURRENCY,
    async (row) => {
      try {
        return {
          row,
          detailed: await enrichRaider(row, now, effectiveRaidProgressTierId),
        };
      } catch (error) {
        console.error('Raider detail enrichment failed', {
          charId: row.blizzard_char_id,
          name: row.name,
          realmSlug: row.realm_slug,
          error,
        });
        return {
          row,
          detailed: null as RaiderRecord | null,
        };
      }
    }
  );

  // Fetch old world-vault data to compute delve objectives on weekly rollover.
  type OldMetricsRow = {
    blizzard_char_id: number;
    details_synced_at: number | null;
    world_vault_weekly_objectives: number | null;
    world_vault_quantity_snapshot: number | null;
  };
  const oldMythicMap = new Map<number, {
    syncedAt: number | null;
    worldWeekly: number | null;
    worldSnapshot: number | null;
  }>();
  if (detailCandidates.length > 0) {
    const placeholders = detailCandidates.map(() => '?').join(',');
    const oldRows = await db
      .prepare(
        `SELECT blizzard_char_id, details_synced_at, world_vault_weekly_objectives, world_vault_quantity_snapshot
         FROM raider_metrics_cache
         WHERE blizzard_char_id IN (${placeholders})`
      )
      .bind(...detailCandidates.map((c) => c.blizzard_char_id))
      .all<OldMetricsRow>();
    for (const r of oldRows.results ?? []) {
      oldMythicMap.set(r.blizzard_char_id, {
        syncedAt: r.details_synced_at,
        worldWeekly: r.world_vault_weekly_objectives,
        worldSnapshot: r.world_vault_quantity_snapshot,
      });
    }
  }

  for (let i = 0; i < detailCandidates.length; i += 1) {
    const source = detailCandidates[i];
    const detailed = detailResults[i]?.detailed ?? null;
    if (!detailed) continue;

    // Accumulate keystones from this refresh into the persistent keystones table,
    // then count weekly/season totals directly from that table.
    const old = oldMythicMap.get(source.blizzard_char_id);
    let newWorldWeeklyObjectives: number | null = null;
    let newWorldSnapshot: number | null = old?.worldSnapshot ?? null;

    await mergeKeystoneRuns(db, source.blizzard_char_id, detailed.mythicPlusAllRuns);
    let keystoneCounts = await countKeystoneRuns(db, source.blizzard_char_id, weeklyResetTs);

    // Bootstrap/top-up from the RIO stats endpoint (same source as the stats page).
    // If profile-derived lists undercount, add synthetic placeholders up to statsTotal.
    const statsTotal = await fetchStatisticsWeeklyTotal(source.realm_slug, source.name).catch(() => null);
    if (statsTotal !== null && statsTotal > keystoneCounts.weekly) {
      const missing = statsTotal - keystoneCounts.weekly;
      const syntheticRuns: KeystoneRun[] = Array.from({ length: missing }, (_, idx) => ({
        completedTs: weeklyResetTs + keystoneCounts.weekly + idx + 1,
        dungeonId: null,
        keystoneLevel: null,
      }));
      await mergeKeystoneRuns(db, source.blizzard_char_id, syntheticRuns);
      keystoneCounts = await countKeystoneRuns(db, source.blizzard_char_id, weeklyResetTs);
    }

    const newWeeklyRuns: number = keystoneCounts.weekly;
    const newSeasonRunsRaw: number = keystoneCounts.season;
    const isSeasonWeekOne = now >= MIDNIGHT_SEASON_1_START_TIMESTAMP && now < MIDNIGHT_SEASON_1_START_TIMESTAMP + WEEK_SECONDS;
    const newSeasonRuns: number = isSeasonWeekOne ? newWeeklyRuns : newSeasonRunsRaw;
    const newPrevWeeklyRuns: number | null = keystoneCounts.prevWeekly;
    const keystoneVaultKeyLevels = keystoneCounts.weeklyKeyLevels;

    const worldLifetime = detailed.worldVaultLifetimeObjectives;
    if (worldLifetime !== null) {
      const duringFirstWeek = now >= MIDNIGHT_SEASON_1_START_TIMESTAMP && now < MIDNIGHT_SEASON_1_START_TIMESTAMP + WEEK_SECONDS;
      const shouldBootstrapWorldFromLifetimeTotal =
        duringFirstWeek &&
        worldLifetime > 0 &&
        (old?.worldWeekly ?? 0) === 0 &&
        ((old?.worldSnapshot ?? null) === null || (old?.worldSnapshot ?? 0) === worldLifetime);

      if (shouldBootstrapWorldFromLifetimeTotal) {
        // If world-vault tracking ships after players already did delves during the
        // first season week, treating the current total as the baseline erases all
        // current-week progress. Bootstrap from the current total instead.
        newWorldSnapshot = 0;
        newWorldWeeklyObjectives = worldLifetime;
      } else if (old && old.syncedAt !== null && old.syncedAt < weeklyResetTs) {
        newWorldSnapshot = worldLifetime;
        newWorldWeeklyObjectives = 0;
      } else if (newWorldSnapshot !== null && newWorldSnapshot >= 0) {
        newWorldWeeklyObjectives = Math.max(0, worldLifetime - newWorldSnapshot);
      } else {
        newWorldSnapshot = worldLifetime;
        newWorldWeeklyObjectives = 0;
      }
    } else {
      newWorldWeeklyObjectives = old?.worldWeekly ?? null;
    }

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
             adventurer_crests = ?,
             veteran_crests = ?,
             champion_crests = ?,
             hero_crests = ?,
             myth_crests = ?,
             mythic_plus_run_count = ?,
             mythic_plus_weekly_runs = ?,
             mythic_plus_prev_weekly_runs = ?,
             mythic_plus_season_runs = ?,
             mythic_plus_vault_ilvl_1 = ?,
             mythic_plus_vault_ilvl_2 = ?,
             mythic_plus_vault_ilvl_3 = ?,
             world_vault_weekly_objectives = ?,
             world_vault_quantity_snapshot = ?,
             mythic_plus_quantity_snapshot = ?,
             total_upgrades_missing = ?,
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
        detailed.adventurerCrests,
        detailed.veteranCrests,
        detailed.championCrests,
        detailed.heroCrests,
        detailed.mythCrests,
        detailed.mythicPlusRunCount,
        newWeeklyRuns,
        newPrevWeeklyRuns,
        newSeasonRuns,
        computeVaultIlvl(keystoneVaultKeyLevels, 0),
        computeVaultIlvl(keystoneVaultKeyLevels, 3),
        computeVaultIlvl(keystoneVaultKeyLevels, 7),
        newWorldWeeklyObjectives,
        newWorldSnapshot,
        null, // mythic_plus_quantity_snapshot no longer used
        detailed.totalUpgradesMissing,
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

    // Record histories independently so one schema drift does not block the other.
    await recordPreparednessHistory(db, detailed, now);
    await recordProgressionHistory(db, detailed, now);
    await recordVaultHistorySnapshot(db, detailed, now, newWorldWeeklyObjectives);

    try {
      await calculateAndUpdatePreparednessAverages(db, detailed.blizzardCharId, now);
    } catch (error) {
      console.error('Preparedness rolling-average update failed for raider', {
        charId: detailed.blizzardCharId,
        error,
      });
    }
  }

  // Prune preparedness history older than 2 weeks
  const prepCutoff = now - PREPAREDNESS_HISTORY_WINDOW_SECONDS;
  await prunePreparednessHistory(db, prepCutoff);

  // Prune progression history older than 8 weeks
  const progCutoff = now - PROGRESSION_HISTORY_WINDOW_SECONDS;
  await pruneProgressionHistory(db, progCutoff);

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

export async function getRaiderGear(charId: number, dbInput?: D1Database): Promise<RaiderGearItem[]> {
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
  if (!row || !accessToken) return [];

  const url = buildCharacterUrl(row.realm_slug, row.name, '/equipment');
  const equipment = await fetchBlizzardJsonWithRetry<BlizzardEquipmentResponse>(url, accessToken);
  const items = equipment?.equipped_items ?? [];

  const bySlot = new Map<string, BlizzardEquippedItem>();
  for (const item of items) {
    const slotType = (item.slot?.type ?? '').toUpperCase();
    if (!slotType) continue;
    bySlot.set(slotType, item);
  }

  return GEAR_SLOT_ORDER.map((slotKey) => {
    const item = bySlot.get(slotKey);
    if (!item) {
      return {
        slotKey,
        slotLabel: gearSlotLabel(slotKey),
        itemName: null,
        itemId: null,
        itemLevel: null,
        quality: null,
        qualityColor: '#90a4b2',
        enchantments: [],
        gems: [],
        stats: [],
        socketsFilled: 0,
        socketsTotal: 0,
        canEnchant: false,
        canGem: false,
      } satisfies RaiderGearItem;
    }

    const sockets = item.sockets ?? [];
    const socketsTotal = sockets.length;
    const socketsFilled = sockets.filter((socket) => socket.item || socket.media || socket.display_string).length;
    const enchantments = (item.enchantments ?? [])
      .map((entry) => formatEnchantmentLabel(entry?.display_string ?? ''))
      .filter((text): text is string => Boolean(text && text.length > 0));

    const gems = sockets
      .map((socket) => (socket.item?.name ?? socket.display_string ?? '').trim())
      .filter((text) => text.length > 0);

    const stats = (item.stats ?? [])
      .map((entry) => formatItemStat(entry))
      .filter((text): text is string => Boolean(text));

    return {
      slotKey,
      slotLabel: gearSlotLabel(slotKey),
      itemName: item.name ?? null,
      itemId: item.item?.id ?? null,
      itemLevel: item.level?.value ?? null,
      quality: item.quality?.type ?? null,
      qualityColor: itemQualityColor(item.quality?.type),
      enchantments,
      gems,
      stats,
      socketsFilled,
      socketsTotal,
      canEnchant: isEnchantableItem(slotKey, item),
      canGem: socketsTotal > 0,
    } satisfies RaiderGearItem;
  });
}

export interface PreparednessHistoryRow {
  recordedAt: number;
  socketedGems: number | null;
  totalSockets: number | null;
  enchantedSlots: number | null;
  enchantableSlots: number | null;
}

export async function getPreparednessHistory(charId: number, dbInput?: D1Database): Promise<PreparednessHistoryRow[]> {
  const db = getDatabase(dbInput);
  const cutoff = nowInSeconds() - PREPAREDNESS_HISTORY_WINDOW_SECONDS;

  const result = await db
    .prepare(
      `WITH latest_per_day AS (
         SELECT MAX(recorded_at) AS recorded_at
         FROM raider_preparedness_history
         WHERE blizzard_char_id = ?
           AND recorded_at >= ?
         GROUP BY date(recorded_at, 'unixepoch')
       )
       SELECT
         h.recorded_at,
         h.socketed_gems,
         h.total_sockets,
         h.enchanted_slots,
         h.enchantable_slots
       FROM raider_preparedness_history h
       JOIN latest_per_day d ON d.recorded_at = h.recorded_at
       WHERE h.blizzard_char_id = ?
       ORDER BY h.recorded_at DESC`
    )
    .bind(charId, cutoff, charId)
    .all<{
      recorded_at: number;
      socketed_gems: number | null;
      total_sockets: number | null;
      enchanted_slots: number | null;
      enchantable_slots: number | null;
    }>();

  return (result.results ?? []).map((row) => ({
    recordedAt: row.recorded_at,
    socketedGems: row.socketed_gems,
    totalSockets: row.total_sockets,
    enchantedSlots: row.enchanted_slots,
    enchantableSlots: row.enchantable_slots,
  }));
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
           adventurer_crests,
           veteran_crests,
           champion_crests,
           hero_crests,
           myth_crests,
          mythic_plus_run_count,
          mythic_plus_weekly_runs,
          mythic_plus_prev_weekly_runs,
          mythic_plus_season_runs,
          mythic_plus_vault_ilvl_1,
          mythic_plus_vault_ilvl_2,
          mythic_plus_vault_ilvl_3,
          world_vault_weekly_objectives,
          total_upgrades_missing,
          raid_progress_raid_name,
           raid_progress_label,
           raid_progress_kills,
           raid_progress_total,
          details_synced_at,
          avg_30d_socketed_gems,
          avg_30d_total_sockets,
          avg_30d_enchanted_slots,
          avg_30d_enchantable_slots
       FROM raider_metrics_cache
       WHERE blizzard_char_id = ?`
    )
    .bind(charId)
    .first<CachedRaiderRow>();

  if (!row) return null;

  return {
    blizzardCharId: row.blizzard_char_id,
    name: toNonEmptyString(row.name, `Unknown-${row.blizzard_char_id}`),
    realm: toNonEmptyString(row.realm, 'Unknown Realm'),
    realmSlug: toNonEmptyString(row.realm_slug, 'unknown-realm'),
    className: toNonEmptyString(row.class_name, 'Unknown'),
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
    adventurerCrests: row.adventurer_crests,
    veteranCrests: row.veteran_crests,
    championCrests: row.champion_crests,
    heroCrests: row.hero_crests,
    mythCrests: row.myth_crests,
    mythicPlusRunCount: computeDisplayedMythicPlusTotal(row),
    mythicPlusWeeklyRuns: row.mythic_plus_weekly_runs,
    mythicPlusPrevWeeklyRuns: row.mythic_plus_prev_weekly_runs,
    mythicPlusSeasonRuns: row.mythic_plus_season_runs,
    mythicPlusVaultIlvl1: row.mythic_plus_vault_ilvl_1,
    mythicPlusVaultIlvl2: row.mythic_plus_vault_ilvl_2,
    mythicPlusVaultIlvl3: row.mythic_plus_vault_ilvl_3,
    mythicPlusLifetimeTotal: row.mythic_plus_run_count,
    worldVaultWeeklyObjectives: row.world_vault_weekly_objectives,
    worldVaultLifetimeObjectives: null,
    totalUpgradesMissing: row.total_upgrades_missing,
    raidProgressRaidName: row.raid_progress_raid_name,
    raidProgressLabel: row.raid_progress_label,
    raidProgressKills: row.raid_progress_kills,
    raidProgressTotal: row.raid_progress_total,
    avg30dSocketedGems: row.avg_30d_socketed_gems,
    avg30dTotalSockets: row.avg_30d_total_sockets,
    avg30dEnchantedSlots: row.avg_30d_enchanted_slots,
    avg30dEnchantableSlots: row.avg_30d_enchantable_slots,
    singleTargetDps: null,
    singleTargetUpdatedAt: null,
    droptimizerUpdatedAt: null,
  };
}

export interface ProgressionHistoryRow {
  recordedAt: number;
  equippedItemLevel: number | null;
  mythicScore: number | null;
  adventurerCrests: number | null;
  veteranCrests: number | null;
  championCrests: number | null;
  heroCrests: number | null;
  mythCrests: number | null;
  totalUpgradesMissing: number | null;
}

export interface VaultHistoryRow {
  weekStartTs: number;
  weekEndTs: number;
  snapshotTs: number;
  raidWeeklyBossKills: number | null;
  raidSlot1Ilvl: number | null;
  raidSlot2Ilvl: number | null;
  raidSlot3Ilvl: number | null;
  dungeonSlot1Ilvl: number | null;
  dungeonSlot2Ilvl: number | null;
  dungeonSlot3Ilvl: number | null;
  worldWeeklyObjectives: number | null;
  raidSlotsFilled: number;
  dungeonSlotsFilled: number;
  worldSlotsFilled: number;
  totalSlotsFilled: number;
}

export async function getVaultHistory(charId: number, dbInput?: D1Database): Promise<VaultHistoryRow[]> {
  const db = getDatabase(dbInput);
  const cutoffWeekStart = getUsWeeklyResetTimestamp() - VAULT_HISTORY_WINDOW_SECONDS;

  const result = await db
    .prepare(
      `SELECT
         week_start_ts,
         week_end_ts,
         snapshot_ts,
         raid_weekly_boss_kills,
         raid_slot_1_ilvl,
         raid_slot_2_ilvl,
         raid_slot_3_ilvl,
         dungeon_slot_1_ilvl,
         dungeon_slot_2_ilvl,
         dungeon_slot_3_ilvl,
         (
           SELECT rk1.keystone_level
           FROM raider_keystones rk1
           WHERE rk1.blizzard_char_id = raider_vault_history.blizzard_char_id
             AND rk1.completed_ts >= raider_vault_history.week_start_ts
             AND rk1.completed_ts < raider_vault_history.week_end_ts
             AND rk1.keystone_level IS NOT NULL
           ORDER BY rk1.keystone_level DESC
           LIMIT 1 OFFSET 0
         ) AS fallback_keystone_level_1,
         (
           SELECT rk4.keystone_level
           FROM raider_keystones rk4
           WHERE rk4.blizzard_char_id = raider_vault_history.blizzard_char_id
             AND rk4.completed_ts >= raider_vault_history.week_start_ts
             AND rk4.completed_ts < raider_vault_history.week_end_ts
             AND rk4.keystone_level IS NOT NULL
           ORDER BY rk4.keystone_level DESC
           LIMIT 1 OFFSET 3
         ) AS fallback_keystone_level_4,
         (
           SELECT rk8.keystone_level
           FROM raider_keystones rk8
           WHERE rk8.blizzard_char_id = raider_vault_history.blizzard_char_id
             AND rk8.completed_ts >= raider_vault_history.week_start_ts
             AND rk8.completed_ts < raider_vault_history.week_end_ts
             AND rk8.keystone_level IS NOT NULL
           ORDER BY rk8.keystone_level DESC
           LIMIT 1 OFFSET 7
         ) AS fallback_keystone_level_8,
         world_weekly_objectives,
         raid_slots_filled,
         dungeon_slots_filled,
         world_slots_filled,
         total_slots_filled
       FROM raider_vault_history
       WHERE blizzard_char_id = ?
         AND week_start_ts >= ?
       ORDER BY week_start_ts DESC`
    )
    .bind(charId, cutoffWeekStart)
    .all<{
      week_start_ts: number;
      week_end_ts: number;
      snapshot_ts: number;
      raid_weekly_boss_kills: number | null;
      raid_slot_1_ilvl: number | null;
      raid_slot_2_ilvl: number | null;
      raid_slot_3_ilvl: number | null;
      dungeon_slot_1_ilvl: number | null;
      dungeon_slot_2_ilvl: number | null;
      dungeon_slot_3_ilvl: number | null;
      fallback_keystone_level_1: number | null;
      fallback_keystone_level_4: number | null;
      fallback_keystone_level_8: number | null;
      world_weekly_objectives: number | null;
      raid_slots_filled: number | null;
      dungeon_slots_filled: number | null;
      world_slots_filled: number | null;
      total_slots_filled: number | null;
    }>();

  return (result.results ?? []).map((row) => {
    const fallbackSlot1 = computeVaultIlvlFromLevel(row.fallback_keystone_level_1);
    const fallbackSlot2 = computeVaultIlvlFromLevel(row.fallback_keystone_level_4);
    const fallbackSlot3 = computeVaultIlvlFromLevel(row.fallback_keystone_level_8);
    const dungeonSlot1Ilvl = row.dungeon_slot_1_ilvl ?? fallbackSlot1;
    const dungeonSlot2Ilvl = row.dungeon_slot_2_ilvl ?? fallbackSlot2;
    const dungeonSlot3Ilvl = row.dungeon_slot_3_ilvl ?? fallbackSlot3;
    const effectiveDungeonFilled = [dungeonSlot1Ilvl, dungeonSlot2Ilvl, dungeonSlot3Ilvl]
      .filter((value) => value !== null).length;
    const raidSlotsFilled = Math.max(0, row.raid_slots_filled ?? 0);
    const worldSlotsFilled = Math.max(0, row.world_slots_filled ?? 0);
    const dungeonSlotsFilled = Math.max(Math.max(0, row.dungeon_slots_filled ?? 0), effectiveDungeonFilled);
    const recomputedTotal = raidSlotsFilled + effectiveDungeonFilled + worldSlotsFilled;
    const totalSlotsFilled = Math.max(Math.max(0, row.total_slots_filled ?? 0), recomputedTotal);

    return {
      weekStartTs: row.week_start_ts,
      weekEndTs: row.week_end_ts,
      snapshotTs: row.snapshot_ts,
      raidWeeklyBossKills: row.raid_weekly_boss_kills,
      raidSlot1Ilvl: row.raid_slot_1_ilvl,
      raidSlot2Ilvl: row.raid_slot_2_ilvl,
      raidSlot3Ilvl: row.raid_slot_3_ilvl,
      dungeonSlot1Ilvl,
      dungeonSlot2Ilvl,
      dungeonSlot3Ilvl,
      worldWeeklyObjectives: row.world_weekly_objectives,
      raidSlotsFilled,
      dungeonSlotsFilled,
      worldSlotsFilled,
      totalSlotsFilled,
    };
  });
}

export async function getProgressionHistory(charId: number, dbInput?: D1Database): Promise<ProgressionHistoryRow[]> {
  const db = getDatabase(dbInput);
  const cutoff = nowInSeconds() - PROGRESSION_HISTORY_WINDOW_SECONDS;

  const result = await db
    .prepare(
      `WITH latest_per_day AS (
         SELECT MAX(recorded_at) AS recorded_at
         FROM raider_progression_history
         WHERE blizzard_char_id = ?
           AND recorded_at >= ?
         GROUP BY date(recorded_at, 'unixepoch')
       )
       SELECT
         h.recorded_at,
         h.equipped_item_level,
         h.mythic_score,
         h.adventurer_crests,
         h.veteran_crests,
         h.champion_crests,
         h.hero_crests,
         h.myth_crests,
         h.total_upgrades_missing
       FROM raider_progression_history h
       JOIN latest_per_day d ON d.recorded_at = h.recorded_at
       WHERE h.blizzard_char_id = ?
       ORDER BY h.recorded_at DESC`
    )
    .bind(charId, cutoff, charId)
    .all<{
      recorded_at: number;
      equipped_item_level: number | null;
      mythic_score: number | null;
      adventurer_crests: number | null;
      veteran_crests: number | null;
      champion_crests: number | null;
      hero_crests: number | null;
      myth_crests: number | null;
      total_upgrades_missing: number | null;
    }>();

  return (result.results ?? []).map((row) => ({
    recordedAt: row.recorded_at,
    equippedItemLevel: row.equipped_item_level,
    mythicScore: row.mythic_score,
    adventurerCrests: row.adventurer_crests,
    veteranCrests: row.veteran_crests,
    championCrests: row.champion_crests,
    heroCrests: row.hero_crests,
    mythCrests: row.myth_crests,
    totalUpgradesMissing: row.total_upgrades_missing,
  }));
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

  // Keep page requests cheap: rely on cron/admin refresh for detail backfills.
  raiders = raiders.map((raider) => ({
    ...raider,
    classIconUrl: fallbackClassIconUrl(raider.className),
  }));

  try {
    const singleTargetMap = await getLatestSingleTargetForRaiders(
      db,
      raiders.map((raider) => raider.blizzardCharId),
      { maxAgeSeconds: 14 * 24 * 60 * 60 }
    );
    const droptimizerMap = await getLatestDroptimizerForRaiders(
      db,
      raiders.map((raider) => raider.blizzardCharId),
      { maxAgeSeconds: 14 * 24 * 60 * 60 }
    );

    raiders = raiders.map((raider) => {
      const snapshot = singleTargetMap.get(raider.blizzardCharId);
      const droptimizer = droptimizerMap.get(raider.blizzardCharId);
      return {
        ...raider,
        singleTargetDps: snapshot?.baseline_dps ?? null,
        singleTargetUpdatedAt: snapshot?.updated_at ?? null,
        droptimizerUpdatedAt: droptimizer?.updated_at ?? null,
      };
    });
  } catch (error) {
    if (!errorMessage) {
      errorMessage = error instanceof Error ? error.message : 'Unable to load single-target snapshots.';
    }
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
