import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';

const WCL_OAUTH_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_GRAPHQL_URL = 'https://www.warcraftlogs.com/api/v2/client';
const CACHE_KEY_PREFIX = 'trinket_tier_data_v8';
const CACHE_SCHEMA_VERSION = 8;
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const ZONE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const ZONE_CACHE_KEY = 'trinket_resolved_zone_v1';
const MAX_PARSE_ROWS = 100;
const MAX_PARSE_SCAN_ROWS = 300;
const INITIAL_RANKING_PAGES = 3;
const EXTENDED_RANKING_PAGES = 8;

const WCL_QUERY_RETRY_DELAYS_MS = [600, 2000];
const WCL_AGGREGATE_INTER_ENCOUNTER_SLEEP_MS = 300;
const WCL_MISSING_SPEC_RETRY_DELAY_MS = 1200;

interface WclAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface WclZoneMeta {
  id: number;
  name: string;
  encounters: Array<{ id: number; name: string }>;
  difficulties: Array<{ id: number; name?: string | null }>;
  partitions: Array<{ id: number; name?: string | null }>;
  brackets: Array<{ min: number; max: number; bucket: number; type?: string | null }>;
}

interface WclSpecMeta {
  className: string;
  classSlug: string;
  specName: string;
  specSlug: string;
  role: 'Tank' | 'Healer' | 'DPS';
  metric: 'dps' | 'hps';
}

interface TrinketUsageAggregate {
  itemId: number;
  itemName: string;
  iconName: string | null;
  iconUrl: string | null;
  uses: number;
  weightedAmountTotal: number;
}

export interface SpecTrinketTierRow {
  itemId: number;
  itemName: string;
  iconName: string | null;
  iconUrl: string | null;
  tier: 'S' | 'A' | 'B' | 'C' | 'D';
  uses: number;
  usageRate: number;
  avgParseAmount: number;
}

export interface SpecTrinketTierResult {
  className: string;
  classSlug: string;
  specName: string;
  specSlug: string;
  role: 'Tank' | 'Healer' | 'DPS';
  metric: 'dps' | 'hps';
  parseCount: number;
  trinketRows: SpecTrinketTierRow[];
}

export interface TrinketTierPageData {
  cacheSchemaVersion?: number;
  generatedAtEpoch: number;
  zoneId: number;
  zoneName: string;
  selectedView: 'raid-all' | 'encounter';
  encounterId: number | null;
  encounterName: string;
  difficultyId: number | null;
  difficultyName: string | null;
  partitionId: number | null;
  partitionName: string | null;
  availableEncounters: Array<{ id: number; name: string }>;
  specs: SpecTrinketTierResult[];
  warning: string | null;
}

interface SiteSettingRow {
  value: string | null;
}

interface WclRawRankingRow {
  amount?: number;
  total?: number;
  bracketData?: number | string;
  combatantInfo?: {
    gear?: WclRawGearRow[];
  };
  gear?: WclRawGearRow[];
  reportID?: string;
  reportCode?: string;
  report?: string;
  fightID?: number;
  startTime?: number;
}

interface WclRawGearRow {
  id?: number;
  itemID?: number;
  name?: string;
  icon?: string;
  itemLevel?: number | string;
  slot?: number | string;
  slotName?: string;
  type?: string;
}

interface WclCharacterRankingsPayload {
  rankings?: WclRawRankingRow[];
}

let wclTokenCache: { accessToken: string; expiresAt: number } | null = null;
let wclZoneCache: { raidZone: WclZoneMeta | null; dungeonZone: WclZoneMeta | null; expiresAt: number } | null = null;

const inMemoryCache = new Map<string, { expiresAt: number; payload: TrinketTierPageData }>();

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function readEnv(key: string): string | undefined {
  const runtimeValue = (env as unknown as Record<string, string | undefined>)[key];
  if (runtimeValue && runtimeValue.trim()) {
    return runtimeValue;
  }

  const viteValue = (import.meta.env as Record<string, string | undefined>)[key];
  if (viteValue && viteValue.trim()) {
    return viteValue;
  }

  return undefined;
}

function getWclAuthConfig(): WclAuthConfig | null {
  const clientId = (readEnv('WCL_CLIENT_ID') ?? '').trim();
  const clientSecret = (readEnv('WCL_CLIENT_SECRET') ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function toBase64(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value);
  }

  return Buffer.from(value, 'utf8').toString('base64');
}

function normalizeRoleForSpec(specSlug: string, specName: string): 'Tank' | 'Healer' | 'DPS' {
  const normalizedSlug = specSlug.trim().toLowerCase();
  const normalizedName = specName.trim().toLowerCase();
  const tankSpecs = new Set(['blood', 'vengeance', 'guardian', 'brewmaster', 'protection']);
  const healerSpecs = new Set(['restoration', 'holy', 'discipline', 'mistweaver', 'preservation']);

  if (tankSpecs.has(normalizedSlug) || tankSpecs.has(normalizedName)) return 'Tank';
  if (healerSpecs.has(normalizedSlug) || healerSpecs.has(normalizedName)) return 'Healer';

  if (normalizedSlug.includes('tank')) return 'Tank';
  if (normalizedSlug.includes('heal')) return 'Healer';
  return 'DPS';
}

function normalizeClassFilterValue(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

async function mapWithConcurrency<T, R>(
  rows: T[],
  concurrency: number,
  mapper: (row: T) => Promise<R>
): Promise<R[]> {
  if (rows.length === 0) return [];
  const clampedConcurrency = Math.max(1, Math.min(concurrency, rows.length));
  const output: R[] = new Array(rows.length);
  let index = 0;

  const workers = Array.from({ length: clampedConcurrency }, async () => {
    while (index < rows.length) {
      const current = index;
      index += 1;
      output[current] = await mapper(rows[current]);
    }
  });

  await Promise.all(workers);
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueBy<T>(rows: T[], keySelector: (row: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const row of rows) {
    const key = keySelector(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function parseWclJsonField<T>(input: unknown): T | null {
  if (input == null) return null;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as T;
    } catch {
      return null;
    }
  }
  if (typeof input === 'object') {
    return input as T;
  }
  return null;
}

function toPositiveInt(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function toRankingAmount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function toGearRows(ranking: WclRawRankingRow): WclRawGearRow[] {
  if (Array.isArray(ranking.combatantInfo?.gear)) return ranking.combatantInfo?.gear ?? [];
  if (Array.isArray(ranking.gear)) return ranking.gear;
  return [];
}

function countRankingsWithUsableGear(rows: WclRawRankingRow[]): number {
  let count = 0;
  for (const row of rows) {
    const gearRows = toGearRows(row);
    if (gearRows.length === 0) continue;
    if (gearRows.some((gearRow) => toPositiveInt(gearRow.itemID ?? gearRow.id) !== null)) {
      count += 1;
    }
  }
  return count;
}

function normalizeIconName(icon: string | null | undefined): string | null {
  const raw = (icon ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return null;
  }

  return raw.toLowerCase();
}

function toTrinketIconUrl(icon: string | null | undefined): string | null {
  const raw = (icon ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }

  const iconName = raw.toLowerCase();
  return `https://wow.zamimg.com/images/wow/icons/large/${iconName}`;
}

function isTrinketSlot(row: WclRawGearRow, index: number, totalItems: number): boolean {
  const slotNum = typeof row.slot === 'number' ? row.slot : Number.parseInt(String(row.slot ?? '').trim(), 10);
  if (Number.isFinite(slotNum) && (slotNum === 12 || slotNum === 13)) {
    return true;
  }
  const slotName = (row.slotName ?? '').toLowerCase();
  const type = (row.type ?? '').toLowerCase();
  if (slotName.includes('trinket') || type.includes('trinket')) {
    return true;
  }

  // WCL rankings payload can omit explicit slot labels; default gear ordering puts trinkets at 12/13.
  if (totalItems >= 14 && (index === 12 || index === 13)) {
    const itemId = toPositiveInt(row.itemID ?? row.id);
    return itemId !== null && itemId > 0;
  }

  return false;
}

function toItemLevel(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function fallbackTrinketsFromGearRows(gearRows: WclRawGearRow[]): WclRawGearRow[] {
  const candidates = gearRows
    .map((row) => ({
      row,
      itemId: toPositiveInt(row.itemID ?? row.id),
      level: toItemLevel(row.itemLevel),
      slotName: (row.slotName ?? '').toLowerCase(),
      type: (row.type ?? '').toLowerCase(),
      icon: (row.icon ?? '').toLowerCase(),
    }))
    .filter((entry) => entry.itemId !== null)
    .filter((entry) =>
      entry.slotName.includes('trinket') ||
      entry.type.includes('trinket') ||
      entry.slotName.includes('finger') ||
      entry.type.includes('finger') ||
      entry.slotName.includes('neck') ||
      entry.type.includes('neck') ||
      entry.icon.includes('inv_jewelry') ||
      entry.icon.includes('inv_12_jewelry') ||
      entry.icon.includes('trinket')
    )
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return (b.itemId ?? 0) - (a.itemId ?? 0);
    });

  const selected: WclRawGearRow[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    const id = candidate.itemId;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    selected.push(candidate.row);
    if (selected.length >= 2) break;
  }

  return selected;
}

function computeTier(useCount: number, topUseCount: number): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (topUseCount <= 0) return 'D';
  const ratio = useCount / topUseCount;
  if (ratio >= 0.85) return 'S';
  if (ratio >= 0.65) return 'A';
  if (ratio >= 0.45) return 'B';
  if (ratio >= 0.25) return 'C';
  return 'D';
}

function zoneSelectionScore(zone: WclZoneMeta): number {
  const name = zone.name.toLowerCase();
  const difficultyIds = new Set(zone.difficulties.map((difficulty) => difficulty.id));

  // WCL difficulty IDs: 1=LFR, 3=Normal, 4=Heroic, 5=Mythic, 10=M+ Timed
  const hasRaidDifficultyProfile = difficultyIds.has(4) && difficultyIds.has(5);
  const hasDungeonDifficultyProfile = (difficultyIds.has(8) || difficultyIds.has(10)) && !difficultyIds.has(5);
  const looksLikeDungeonByName =
    name.includes('dungeon') ||
    name.includes('mythic+') ||
    name.includes('keystone') ||
    name.includes('season');
  const looksLikeBeta = name.includes('beta');
  const looksLikeAggregate = zone.encounters.length < 4;

  let score = 0;
  if (hasRaidDifficultyProfile) score += 200;
  if (zone.encounters.length >= 8) score += 40;
  if (zone.encounters.length >= 10) score += 20;
  if (hasDungeonDifficultyProfile) score -= 160;
  if (looksLikeDungeonByName) score -= 120;
  if (looksLikeBeta) score -= 200;
  if (looksLikeAggregate) score -= 300;

  score += Math.min(zone.id, 100);
  return score;
}

function isDungeonZone(zone: WclZoneMeta): boolean {
  const name = zone.name.toLowerCase();
  const difficultyIds = new Set(zone.difficulties.map((difficulty) => difficulty.id));
  const hasDungeonDifficultyProfile = difficultyIds.has(8) && !difficultyIds.has(15) && !difficultyIds.has(16);
  const hasKeystoneBrackets = zone.brackets.some((bracket) => (bracket.type ?? '').toLowerCase() === 'keystone level');

  return hasDungeonDifficultyProfile || hasKeystoneBrackets || name.includes('mythic+') || name.includes('season');
}

function dungeonZoneSelectionScore(zone: WclZoneMeta): number {
  let score = 0;
  if (isDungeonZone(zone)) score += 300;
  if (zone.encounters.length >= 8) score += 40;
  if ((zone.name ?? '').toLowerCase().includes('mythic+ season')) score += 80;
  score += Math.min(zone.id, 100);
  return score;
}

async function getWclAccessToken(config: WclAuthConfig): Promise<{ accessToken: string | null; error: string | null }> {
  const now = Date.now();
  if (wclTokenCache && wclTokenCache.expiresAt > now) {
    return { accessToken: wclTokenCache.accessToken, error: null };
  }

  try {
    const response = await fetch(WCL_OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${toBase64(`${config.clientId}:${config.clientSecret}`)}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });

    if (!response.ok) {
      return {
        accessToken: null,
        error: `Warcraft Logs OAuth request failed (${response.status}).`,
      };
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    const accessToken = (payload.access_token ?? '').trim();
    if (!accessToken) {
      return {
        accessToken: null,
        error: 'Warcraft Logs OAuth response was missing access token.',
      };
    }

    const expiresIn = Number(payload.expires_in ?? 0);
    wclTokenCache = {
      accessToken,
      expiresAt: now + Math.max(60, expiresIn - 60) * 1000,
    };

    return { accessToken, error: null };
  } catch {
    return {
      accessToken: null,
      error: 'Warcraft Logs OAuth request failed unexpectedly.',
    };
  }
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

  if (!response.ok) return null;
  const payload = (await response.json()) as { data?: T; errors?: unknown[] };
  if ((payload.errors?.length ?? 0) > 0) return null;
  return payload.data ?? null;
}

async function queryWclWithRetry<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T | null> {
  const firstAttempt = await queryWcl<T>(accessToken, query, variables);
  if (firstAttempt) return firstAttempt;

  for (const delayMs of WCL_QUERY_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    const retry = await queryWcl<T>(accessToken, query, variables);
    if (retry) return retry;
  }

  return null;
}

async function listCandidateZones(accessToken: string): Promise<WclZoneMeta[]> {
  const expansionPayload = await queryWclWithRetry<{
    worldData?: {
      expansions?: Array<{ id?: number }>;
    };
  }>(
    accessToken,
    `
      query TrinketExpansions {
        worldData {
          expansions {
            id
          }
        }
      }
    `,
    {}
  );

  const expansionIds = (expansionPayload?.worldData?.expansions ?? [])
    .map((expansion) => toPositiveInt(expansion.id))
    .filter((id): id is number => id !== null)
    .sort((a, b) => b - a);
  const latestExpansionId = expansionIds[0] ?? null;

  async function fetchZonesForExpansion(expansionId: number | null): Promise<WclZoneMeta[]> {
    const zonesPayload = await queryWclWithRetry<{
      worldData?: {
        zones?: Array<{
          id?: number;
          name?: string;
          brackets?:
            | { min?: number; max?: number; bucket?: number; type?: string | null }
            | Array<{ min?: number; max?: number; bucket?: number; type?: string | null }>;
          encounters?: Array<{ id?: number; name?: string }>;
          difficulties?: Array<{ id?: number; name?: string | null }>;
          partitions?: Array<{ id?: number; name?: string | null }>;
        }>;
      };
    }>(
      accessToken,
      `
        query TrinketZones($expansionId: Int) {
          worldData {
            zones(expansion_id: $expansionId) {
              id
              name
              brackets {
                min
                max
                bucket
                type
              }
              encounters {
                id
                name
              }
              difficulties {
                id
                name
              }
              partitions {
                id
                name
              }
            }
          }
        }
      `,
      {
        expansionId,
      }
    );

    return (zonesPayload?.worldData?.zones ?? [])
      .map((zone): WclZoneMeta | null => {
        const zoneId = toPositiveInt(zone.id);
        const zoneName = (zone.name ?? '').trim();
        if (!zoneId || !zoneName) return null;

        const encounters = (zone.encounters ?? [])
          .map((encounter) => {
            const encounterId = toPositiveInt(encounter.id);
            const encounterName = (encounter.name ?? '').trim();
            if (!encounterId || !encounterName) return null;
            return { id: encounterId, name: encounterName };
          })
          .filter((entry): entry is { id: number; name: string } => entry !== null)
          .sort((a, b) => a.id - b.id);

        const bracketRows = Array.isArray(zone.brackets)
          ? zone.brackets
          : zone.brackets
            ? [zone.brackets]
            : [];

        return {
          id: zoneId,
          name: zoneName,
          encounters,
          brackets: bracketRows
            .map((bracket) => ({
              min: Number(bracket.min ?? 0),
              max: Number(bracket.max ?? 0),
              bucket: Number(bracket.bucket ?? 0),
              type: bracket.type ?? null,
            }))
            .filter((bracket) => Number.isFinite(bracket.min) && Number.isFinite(bracket.max) && Number.isFinite(bracket.bucket)),
          difficulties: (zone.difficulties ?? [])
            .map((difficulty) => ({ id: toPositiveInt(difficulty.id) ?? 0, name: difficulty.name ?? null }))
            .filter((difficulty) => difficulty.id > 0),
          partitions: (zone.partitions ?? [])
            .map((partition) => ({ id: toPositiveInt(partition.id) ?? 0, name: partition.name ?? null }))
            .filter((partition) => partition.id > 0),
        };
      })
      .filter((zone): zone is WclZoneMeta => zone !== null)
      .filter((zone) => zone.encounters.length >= 1);
  }

  let candidateZones = await fetchZonesForExpansion(latestExpansionId);
  if (candidateZones.length === 0) {
    candidateZones = await fetchZonesForExpansion(null);
  }

  return candidateZones;
}

async function resolveCurrentContentZones(accessToken: string, db: D1Database): Promise<{ raidZone: WclZoneMeta | null; dungeonZone: WclZoneMeta | null }> {
  const now = nowInSeconds();

  // In-process cache (hits within same isolate lifetime)
  if (wclZoneCache && wclZoneCache.expiresAt > now) {
    return { raidZone: wclZoneCache.raidZone, dungeonZone: wclZoneCache.dungeonZone };
  }

  // D1-backed cache (shared across isolates / warm requests)
  try {
    const row = await db
      .prepare(`SELECT value FROM site_settings WHERE key = ? LIMIT 1`)
      .bind(ZONE_CACHE_KEY)
      .first<SiteSettingRow>();
    const rawValue = (row?.value ?? '').trim();
    if (rawValue) {
      const parsed = JSON.parse(rawValue) as { raidZone: WclZoneMeta | null; dungeonZone: WclZoneMeta | null; cachedAt: number } | null;
      if (parsed && now - parsed.cachedAt < ZONE_CACHE_TTL_SECONDS) {
        const result = { raidZone: parsed.raidZone, dungeonZone: parsed.dungeonZone };
        wclZoneCache = { ...result, expiresAt: parsed.cachedAt + ZONE_CACHE_TTL_SECONDS };
        return result;
      }
    }
  } catch {
    // Fall through to live resolution
  }

  const candidateZones = await listCandidateZones(accessToken);

  const raidCandidates = [...candidateZones].sort((a, b) => {
    const scoreDelta = zoneSelectionScore(b) - zoneSelectionScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return b.id - a.id;
  });

  const dungeonCandidates = candidateZones.filter((zone) => isDungeonZone(zone)).sort((a, b) => {
    const scoreDelta = dungeonZoneSelectionScore(b) - dungeonZoneSelectionScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return b.id - a.id;
  });

  const result = {
    raidZone: raidCandidates[0] ?? null,
    dungeonZone: dungeonCandidates[0] ?? null,
  };

  if (result.raidZone !== null) {
    wclZoneCache = { ...result, expiresAt: now + ZONE_CACHE_TTL_SECONDS };
    const serialized = JSON.stringify({ ...result, cachedAt: now });
    try {
      await db
        .prepare(
          `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(ZONE_CACHE_KEY, serialized)
        .run();
    } catch {
      // Non-fatal; will resolve again next request
    }
  }

  return result;
}

async function listSpecsForZone(accessToken: string, zoneId: number): Promise<WclSpecMeta[]> {
  const payload = await queryWclWithRetry<{
    gameData?: {
      classes?: Array<{
        name?: string;
        slug?: string;
        specs?: Array<{
          name?: string;
          slug?: string;
        }>;
      }>;
    };
  }>(
    accessToken,
    `
      query TrinketSpecs($zoneId: Int) {
        gameData {
          classes(zone_id: $zoneId) {
            name
            slug
            specs {
              name
              slug
            }
          }
        }
      }
    `,
    { zoneId }
  );

  const specs: WclSpecMeta[] = [];
  for (const classRow of payload?.gameData?.classes ?? []) {
    const className = (classRow.name ?? '').trim();
    const classSlug = (classRow.slug ?? '').trim();
    if (!className || !classSlug) continue;

    for (const specRow of classRow.specs ?? []) {
      const specName = (specRow.name ?? '').trim();
      const specSlug = (specRow.slug ?? '').trim();
      if (!specName || !specSlug) continue;

      const role = normalizeRoleForSpec(specSlug, specName);
      specs.push({
        className,
        classSlug,
        specName,
        specSlug,
        role,
        metric: role === 'Healer' ? 'hps' : 'dps',
      });
    }
  }

  return specs.sort((a, b) => {
    const classCmp = a.className.localeCompare(b.className);
    if (classCmp !== 0) return classCmp;
    return a.specName.localeCompare(b.specName);
  });
}

async function fetchTopRankingsForSpec(
  accessToken: string,
  encounterId: number,
  difficultyId: number | null,
  partitionId: number | null,
  spec: WclSpecMeta,
  maxInitialPages = INITIAL_RANKING_PAGES
): Promise<WclRawRankingRow[]> {
  async function fetchAttempt(params: {
    difficulty: number | null;
    partition: number | null;
    className: string;
    specName: string;
  }): Promise<WclRawRankingRow[]> {
    const allRows: WclRawRankingRow[] = [];

    let page = 1;
    let targetPages = maxInitialPages;
    while (page <= targetPages) {
      const payload = await queryWclWithRetry<{
        worldData?: {
          encounter?: {
            characterRankings?: unknown;
          };
        };
      }>(
        accessToken,
        `
          query TrinketCharacterRankings(
            $encounterId: Int!
            $difficulty: Int
            $partition: Int
            $metric: CharacterRankingMetricType
            $className: String
            $specName: String
            $page: Int
          ) {
            worldData {
              encounter(id: $encounterId) {
                characterRankings(
                  difficulty: $difficulty
                  partition: $partition
                  metric: $metric
                  className: $className
                  specName: $specName
                  includeCombatantInfo: true
                  page: $page
                )
              }
            }
          }
        `,
        {
          encounterId,
          difficulty: params.difficulty,
          partition: params.partition,
          metric: spec.metric,
          className: params.className,
          specName: params.specName,
          page,
        }
      );

      const jsonPayload = parseWclJsonField<WclCharacterRankingsPayload>(
        payload?.worldData?.encounter?.characterRankings ?? null
      );
      const pageRows = jsonPayload?.rankings ?? [];
      if (pageRows.length === 0) break;

      allRows.push(...pageRows);
      const hasEnoughRows = allRows.length >= MAX_PARSE_ROWS;
      const usableGearCount = countRankingsWithUsableGear(allRows);

      // If first pages have no usable combatant gear data, scan deeper pages to recover trinket signal.
      // Only extend if we started with the full initial page budget (not in single-page aggregate mode).
      if (hasEnoughRows && usableGearCount === 0 && maxInitialPages >= INITIAL_RANKING_PAGES && targetPages < EXTENDED_RANKING_PAGES) {
        targetPages = EXTENDED_RANKING_PAGES;
      }

      if (allRows.length >= MAX_PARSE_SCAN_ROWS) break;
      if (usableGearCount >= Math.min(15, allRows.length)) break;

      page += 1;
    }

    const deduped = uniqueBy(allRows, (row) => {
      const report = String(row.reportID ?? row.reportCode ?? row.report ?? 'unknown');
      const fightId = Number(row.fightID ?? 0);
      const startTime = Number(row.startTime ?? 0);
      return `${report}:${fightId}:${startTime}:${Math.round(toRankingAmount(row.amount ?? row.total))}`;
    });

    return deduped.slice(0, MAX_PARSE_SCAN_ROWS);
  }

  const attempts = [
    { difficulty: difficultyId, partition: partitionId, className: spec.classSlug, specName: spec.specSlug },
    { difficulty: difficultyId, partition: null, className: spec.classSlug, specName: spec.specSlug },
    { difficulty: null, partition: null, className: spec.classSlug, specName: spec.specSlug },
    { difficulty: difficultyId, partition: null, className: spec.className, specName: spec.specName },
    { difficulty: null, partition: null, className: spec.className, specName: spec.specName },
  ];

  let bestRows: WclRawRankingRow[] = [];
  let bestRowsWithGear = -1;

  for (const attempt of attempts) {
    const rows = await fetchAttempt(attempt);
    if (rows.length === 0) continue;

    const rowsWithGear = countRankingsWithUsableGear(rows);
    if (rowsWithGear > bestRowsWithGear || (rowsWithGear === bestRowsWithGear && rows.length > bestRows.length)) {
      bestRows = rows;
      bestRowsWithGear = rowsWithGear;
    }

    // Stop early if this attempt is clearly high-quality.
    if (rowsWithGear > 0 && rowsWithGear >= Math.min(10, rows.length)) {
      return rows;
    }
  }

  return bestRows;
}

function buildSpecTierRows(rankings: WclRawRankingRow[]): {
  parseCount: number;
  trinketRows: SpecTrinketTierRow[];
} {
  const trinketsById = new Map<number, TrinketUsageAggregate>();
  let parseCount = 0;

  for (const ranking of rankings) {
    const amount = toRankingAmount(ranking.amount ?? ranking.total);
    const gearRows = toGearRows(ranking);
    const explicitTrinketRows = gearRows.filter((gearRow, index) => isTrinketSlot(gearRow, index, gearRows.length));
    const gearRowsForTrinkets = explicitTrinketRows.length > 0 ? explicitTrinketRows : fallbackTrinketsFromGearRows(gearRows);

    const trinketsForRanking = gearRowsForTrinkets
      .map((gearRow) => {
        const itemId = toPositiveInt(gearRow.itemID ?? gearRow.id);
        if (!itemId) return null;
        const itemName = (gearRow.name ?? '').trim() || `Item ${itemId}`;
        return {
          itemId,
          itemName,
          iconName: normalizeIconName(gearRow.icon),
          iconUrl: toTrinketIconUrl(gearRow.icon),
        };
      })
      .filter((entry): entry is { itemId: number; itemName: string; iconName: string | null; iconUrl: string | null } => entry !== null);

    if (trinketsForRanking.length === 0) continue;
    parseCount += 1;

    for (const trinket of trinketsForRanking) {
      const existing = trinketsById.get(trinket.itemId);
      if (existing) {
        existing.uses += 1;
        existing.weightedAmountTotal += amount;
        if (!existing.iconName && trinket.iconName) {
          existing.iconName = trinket.iconName;
        }
        if (!existing.iconUrl && trinket.iconUrl) {
          existing.iconUrl = trinket.iconUrl;
        }
      } else {
        trinketsById.set(trinket.itemId, {
          itemId: trinket.itemId,
          itemName: trinket.itemName,
          iconName: trinket.iconName,
          iconUrl: trinket.iconUrl,
          uses: 1,
          weightedAmountTotal: amount,
        });
      }
    }
  }

  const sorted = [...trinketsById.values()].sort((a, b) => {
    if (b.uses !== a.uses) return b.uses - a.uses;
    return b.weightedAmountTotal - a.weightedAmountTotal;
  });

  const topUseCount = sorted[0]?.uses ?? 0;
  const trinketRows: SpecTrinketTierRow[] = sorted.map((entry) => ({
    itemId: entry.itemId,
    itemName: entry.itemName,
    iconName: entry.iconName,
    iconUrl: entry.iconUrl,
    tier: computeTier(entry.uses, topUseCount),
    uses: entry.uses,
    usageRate: parseCount > 0 ? entry.uses / parseCount : 0,
    avgParseAmount: entry.uses > 0 ? entry.weightedAmountTotal / entry.uses : 0,
  }));

  return {
    parseCount,
    trinketRows,
  };
}

function trimToTopRankings(rows: WclRawRankingRow[], maxRows: number): WclRawRankingRow[] {
  return [...rows]
    .sort((left, right) => toRankingAmount(right.amount ?? right.total) - toRankingAmount(left.amount ?? left.total))
    .slice(0, maxRows);
}

function hasUsableGearData(row: WclRawRankingRow): boolean {
  const gearRows = toGearRows(row);
  if (gearRows.length === 0) return false;

  return gearRows.some((gearRow) => toPositiveInt(gearRow.itemID ?? gearRow.id) !== null);
}

function cacheKeyForSelection(
  encounterId: number | null,
  classFilterKey: string
): string {
  const selectionKey = encounterId === null ? 'all' : String(encounterId);
  return `${CACHE_KEY_PREFIX}:${selectionKey}:class=${classFilterKey}`;
}

async function readCached(
  db: D1Database,
  encounterId: number | null,
  classFilterKey: string
): Promise<TrinketTierPageData | null> {
  try {
    const key = cacheKeyForSelection(encounterId, classFilterKey);
    const memoryCached = inMemoryCache.get(key);
    if (memoryCached && memoryCached.expiresAt > nowInSeconds()) {
      return memoryCached.payload;
    }

    const row = await db
      .prepare(`SELECT value FROM site_settings WHERE key = ? LIMIT 1`)
      .bind(key)
      .first<SiteSettingRow>();

    const rawValue = (row?.value ?? '').trim();
    if (!rawValue) return null;

    let parsed: TrinketTierPageData | null = null;
    try {
      parsed = JSON.parse(rawValue) as TrinketTierPageData;
    } catch {
      return null;
    }

    if (!parsed) return null;
    if ((parsed.cacheSchemaVersion ?? 0) !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (nowInSeconds() - parsed.generatedAtEpoch > CACHE_TTL_SECONDS) {
      return null;
    }
    if (parsed.zoneId <= 0 || parsed.zoneName === 'Unavailable') {
      return null;
    }
    if (parsed.specs.length === 0) {
      return null;
    }
    if ((parsed.warning ?? '').includes('No ranking data was returned')) {
      return null;
    }
    if (parsed.specs.length > 0 && parsed.specs.every((spec) => spec.parseCount === 0)) {
      return null;
    }

    inMemoryCache.set(key, {
      expiresAt: parsed.generatedAtEpoch + CACHE_TTL_SECONDS,
      payload: parsed,
    });
    return parsed;
  } catch {
    return null;
  }
}

async function writeCached(db: D1Database, payload: TrinketTierPageData, classFilterKey: string): Promise<void> {
  if (payload.zoneId <= 0 || payload.zoneName === 'Unavailable') {
    return;
  }
  if (payload.specs.length === 0) {
    return;
  }
  if (payload.specs.length > 0 && payload.specs.every((spec) => spec.parseCount === 0)) {
    return;
  }

  const key = cacheKeyForSelection(
    payload.encounterId,
    classFilterKey
  );
  const serialized = JSON.stringify(payload);

  try {
    await db
      .prepare(
        `INSERT INTO site_settings (key, value, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .bind(key, serialized)
      .run();
  } catch {
    return;
  }

  inMemoryCache.set(key, {
    expiresAt: payload.generatedAtEpoch + CACHE_TTL_SECONDS,
    payload,
  });
}

function buildUnavailablePayload(message: string): TrinketTierPageData {
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    generatedAtEpoch: nowInSeconds(),
    zoneId: 0,
    zoneName: 'Unavailable',
    selectedView: 'raid-all',
    encounterId: null,
    encounterName: 'All Raid Bosses',
    difficultyId: null,
    difficultyName: null,
    partitionId: null,
    partitionName: null,
    availableEncounters: [],
    specs: [],
    warning: message,
  };
}

async function loadTrinketTierPageDataInternal(options?: {
  db?: D1Database;
  encounterId?: number | null;
  classNameFilter?: string | null;
}): Promise<TrinketTierPageData> {
  const db = getDatabase(options?.db);
  const config = getWclAuthConfig();
  if (!config) {
    return buildUnavailablePayload('Warcraft Logs credentials are not configured.');
  }

  const authResult = await getWclAccessToken(config);
  const accessToken = authResult.accessToken;
  if (!accessToken) {
    return buildUnavailablePayload(authResult.error ?? 'Unable to authenticate to Warcraft Logs with configured credentials.');
  }

  const { raidZone } = await resolveCurrentContentZones(accessToken, db);
  if (!raidZone || raidZone.encounters.length === 0) {
    return buildUnavailablePayload('Unable to resolve a current raid zone from Warcraft Logs.');
  }

  const zone = raidZone;

  const requestedEncounterId = toPositiveInt(options?.encounterId ?? null);
  const selectedEncounter = requestedEncounterId
    ? zone.encounters.find((encounter) => encounter.id === requestedEncounterId) ?? null
    : null;

  const normalizedClassFilterRaw = (options?.classNameFilter ?? '').trim();
  const suppressSpecs = normalizedClassFilterRaw === '__none__';
  const normalizedClassFilter = !suppressSpecs && normalizedClassFilterRaw ? normalizeClassFilterValue(normalizedClassFilterRaw) : '';
  const classFilterCacheKey = suppressSpecs ? '__none__' : normalizedClassFilter || 'all';

  const cached = await readCached(db, selectedEncounter?.id ?? null, classFilterCacheKey);
  if (cached) {
    return cached;
  }

  let specs = await listSpecsForZone(accessToken, zone.id);
  if (suppressSpecs) {
    specs = [];
  } else if (normalizedClassFilter) {
    specs = specs.filter((spec) => {
      const classNameNormalized = normalizeClassFilterValue(spec.className);
      const classSlugNormalized = normalizeClassFilterValue(spec.classSlug);
      return classNameNormalized === normalizedClassFilter || classSlugNormalized === normalizedClassFilter;
    });
  }

  const preferredDifficultyIds = [16, 15, 14, 17];
  const difficulty =
    preferredDifficultyIds
      .map((id) => zone.difficulties.find((row) => row.id === id) ?? null)
      .find((row) => row !== null) ??
    [...zone.difficulties].sort((a, b) => b.id - a.id)[0] ??
    null;

  const failures: string[] = [];
  const useAggregateMode = selectedEncounter === null;
  const specConcurrency = useAggregateMode ? 1 : 3;
  const encounterConcurrency = useAggregateMode ? 1 : 2;

  const specResults = await mapWithConcurrency(specs, specConcurrency, async (spec) => {
    try {
      const encounterIds = selectedEncounter
        ? [selectedEncounter.id]
        : zone.encounters.map((encounter) => encounter.id);

      const rankingGroups: Awaited<ReturnType<typeof fetchTopRankingsForSpec>>[] = [];
      for (const encounterId of encounterIds) {
        if (rankingGroups.length > 0 && useAggregateMode) await sleep(WCL_AGGREGATE_INTER_ENCOUNTER_SLEEP_MS);
        const pageLimit = useAggregateMode ? 1 : INITIAL_RANKING_PAGES;
        rankingGroups.push(await fetchTopRankingsForSpec(accessToken, encounterId, difficulty?.id ?? null, null, spec, pageLimit));
      }

      const uniqueRankings = uniqueBy(rankingGroups.flat(), (row) => {
        const report = String(row.reportID ?? row.reportCode ?? row.report ?? 'unknown');
        const fightId = Number(row.fightID ?? 0);
        const startTime = Number(row.startTime ?? 0);
        return `${report}:${fightId}:${startTime}:${Math.round(toRankingAmount(row.amount ?? row.total))}`;
      });

      const rankingsWithGear = uniqueRankings.filter((row) => hasUsableGearData(row));
      const rankingPool = rankingsWithGear.length > 0 ? rankingsWithGear : uniqueRankings;
      const filteredRankings = trimToTopRankings(rankingPool, MAX_PARSE_ROWS);

      if (filteredRankings.length === 0) {
        failures.push(`${spec.specName} ${spec.className}`);
      }

      const tierData = buildSpecTierRows(filteredRankings);
      return {
        className: spec.className,
        classSlug: spec.classSlug,
        specName: spec.specName,
        specSlug: spec.specSlug,
        role: spec.role,
        metric: spec.metric,
        parseCount: tierData.parseCount,
        trinketRows: tierData.trinketRows,
      } satisfies SpecTrinketTierResult;
    } catch {
      failures.push(`${spec.specName} ${spec.className}`);
      return {
        className: spec.className,
        classSlug: spec.classSlug,
        specName: spec.specName,
        specSlug: spec.specSlug,
        role: spec.role,
        metric: spec.metric,
        parseCount: 0,
        trinketRows: [],
      } satisfies SpecTrinketTierResult;
    }
  });

  if (useAggregateMode) {
    for (let index = 0; index < specResults.length; index += 1) {
      const current = specResults[index];
      if (current.parseCount > 0) continue;

      const spec = specs.find(
        (candidate) =>
          candidate.classSlug === current.classSlug &&
          candidate.specSlug === current.specSlug
      );
      if (!spec) continue;

      await sleep(WCL_MISSING_SPEC_RETRY_DELAY_MS);

      try {
        const encounterIds = selectedEncounter
          ? [selectedEncounter.id]
          : zone.encounters.map((encounter) => encounter.id);

        const rankingGroups: Awaited<ReturnType<typeof fetchTopRankingsForSpec>>[] = [];
        for (const encounterId of encounterIds) {
          if (rankingGroups.length > 0) await sleep(WCL_AGGREGATE_INTER_ENCOUNTER_SLEEP_MS);
          rankingGroups.push(await fetchTopRankingsForSpec(accessToken, encounterId, difficulty?.id ?? null, null, spec, 1));
        }

        const uniqueRankings = uniqueBy(rankingGroups.flat(), (row) => {
          const report = String(row.reportID ?? row.reportCode ?? row.report ?? 'unknown');
          const fightId = Number(row.fightID ?? 0);
          const startTime = Number(row.startTime ?? 0);
          return `${report}:${fightId}:${startTime}:${Math.round(toRankingAmount(row.amount ?? row.total))}`;
        });

        const rankingsWithGear = uniqueRankings.filter((row) => hasUsableGearData(row));
        const rankingPool = rankingsWithGear.length > 0 ? rankingsWithGear : uniqueRankings;
        const filteredRankings = trimToTopRankings(rankingPool, MAX_PARSE_ROWS);
        if (filteredRankings.length === 0) continue;

        const tierData = buildSpecTierRows(filteredRankings);
        specResults[index] = {
          ...current,
          parseCount: tierData.parseCount,
          trinketRows: tierData.trinketRows,
        };
      } catch {
        // Keep original zero-parse result if retry also fails.
      }
    }
  }

  const unresolvedSpecCount = specResults.filter((spec) => spec.parseCount === 0).length;

  const payload: TrinketTierPageData = {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    generatedAtEpoch: nowInSeconds(),
    zoneId: zone.id,
    zoneName: zone.name,
    selectedView: selectedEncounter ? 'encounter' : 'raid-all',
    encounterId: selectedEncounter?.id ?? null,
    encounterName: selectedEncounter?.name ?? 'All Raid Bosses',
    difficultyId: difficulty?.id ?? null,
    difficultyName: difficulty?.name ?? null,
    partitionId: null,
    partitionName: null,
    availableEncounters: raidZone.encounters,
    specs: specResults,
    warning: unresolvedSpecCount > 0 ? `No ranking data was returned for ${unresolvedSpecCount} specs in this snapshot.` : null,
  };

  const hasRecoverablePartialFailure = unresolvedSpecCount > 0 && !suppressSpecs;
  if (!hasRecoverablePartialFailure) {
    await writeCached(db, payload, classFilterCacheKey);
  }
  return payload;
}

export async function loadTrinketTierPageData(options?: {
  db?: D1Database;
  encounterId?: number | null;
  classNameFilter?: string | null;
}): Promise<TrinketTierPageData> {
  try {
    return await loadTrinketTierPageDataInternal(options);
  } catch {
    return buildUnavailablePayload('Warcraft Logs returned an unexpected response while loading trinkets.');
  }
}
