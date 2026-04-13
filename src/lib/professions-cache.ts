import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { getBlizzardAppAccessToken } from './blizzard-app-token';
import { fetchBlizzardJsonWithRetry } from './blizzard-fetch';

const REGION = 'us';
const API_BASE = `https://${REGION}.api.blizzard.com`;
const PROFILE_NAMESPACE = `profile-${REGION}`;
const STATIC_NAMESPACE = `static-${REGION}`;
const LOCALE = 'en_US';
const SYNC_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_BATCH_SIZE = 6;

interface RosterMemberRow {
  blizzard_char_id: number;
  name: string;
  realm_slug: string;
  rank: number;
}

interface ProfessionSummaryItem {
  profession?: {
    id?: number;
    name?: string;
  };
}

interface CharacterProfessionSummaryResponse {
  primaries?: ProfessionSummaryItem[];
  secondaries?: ProfessionSummaryItem[];
}

interface ProfessionSummary {
  id: number;
  name: string;
  payload: unknown;
}

interface ProfessionListRow {
  profession_id: number;
  profession_name: string;
  owner_count: number;
  recipe_count: number;
}

interface ProfessionMediaResponse {
  assets?: Array<{
    key?: string;
    value?: string;
  }>;
}

interface ProfessionStaticResponse {
  media?: {
    key?: {
      href?: string;
    };
  };
}

interface RecipeListRow {
  recipe_id: number;
  recipe_name: string;
  owner_count: number;
}

interface RecipeOwnerRow {
  blizzard_char_id: number;
  character_name: string;
  realm_slug: string;
}

interface ProfessionsPageStatus {
  rosterCount: number;
  syncedCount: number;
  staleCount: number;
  oldestSync: number | null;
  newestSync: number | null;
}

export interface ProfessionsRefreshOptions {
  batchSize?: number;
}

export interface ProfessionsRefreshDiagnostics {
  candidatesSelected: number;
  synced: number;
  failed: number;
  skipped: number;
  recipesStored: number;
}

export interface ProfessionsRefreshResult {
  diagnostics: ProfessionsRefreshDiagnostics;
  status: ProfessionsPageStatus;
}

export interface ProfessionSummaryResult {
  professionId: number;
  professionName: string;
  ownerCount: number;
  recipeCount: number;
  iconUrl: string | null;
}

export interface RecipeSummaryResult {
  recipeId: number;
  recipeName: string;
  ownerCount: number;
}

export interface RecipeOwnerResult {
  blizzardCharId: number;
  characterName: string;
  realmSlug: string;
}

export interface ProfessionsPageData {
  status: ProfessionsPageStatus;
  professions: ProfessionSummaryResult[];
  selectedProfession: ProfessionSummaryResult | null;
  recipes: RecipeSummaryResult[];
  selectedRecipe: RecipeSummaryResult | null;
  owners: RecipeOwnerResult[];
}

const professionIconUrlCache = new Map<number, string | null>();

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getDatabase(db?: D1Database): D1Database {
  return db ?? env.DB;
}

function parsePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeCharacterNameForPath(name: string): string {
  return encodeURIComponent(name.trim().toLowerCase());
}

function extractProfessions(summary: CharacterProfessionSummaryResponse | null): ProfessionSummary[] {
  if (!summary) return [];

  const map = new Map<number, ProfessionSummary>();
  const all = [...(summary.primaries ?? []), ...(summary.secondaries ?? [])];

  for (const entry of all) {
    const id = Number(entry.profession?.id);
    const name = String(entry.profession?.name ?? '').trim();
    if (!Number.isFinite(id) || id <= 0 || !name) continue;
    map.set(id, {
      id,
      name,
      payload: entry,
    });
  }

  return Array.from(map.values());
}

function collectRecipesFromArray(
  entries: unknown,
  recipeMap: Map<number, string>
): void {
  if (!Array.isArray(entries)) return;

  for (const rawEntry of entries) {
    const entry = (rawEntry ?? {}) as {
      id?: number;
      name?: string;
      recipe?: { id?: number; name?: string };
    };

    const maybeRecipe = entry.recipe ?? entry;
    const recipeId = Number(maybeRecipe.id);
    const recipeName = String(maybeRecipe.name ?? '').trim();

    if (!Number.isFinite(recipeId) || recipeId <= 0 || !recipeName) continue;
    recipeMap.set(recipeId, recipeName);
  }
}

function collectRecipesFromCategories(entries: unknown, recipeMap: Map<number, string>): void {
  if (!Array.isArray(entries)) return;

  for (const rawEntry of entries) {
    const entry = (rawEntry ?? {}) as {
      known_recipes?: unknown[];
      recipes?: unknown[];
      categories?: unknown[];
      subcategories?: unknown[];
    };

    collectRecipesFromArray(entry.known_recipes, recipeMap);
    collectRecipesFromArray(entry.recipes, recipeMap);
    collectRecipesFromCategories(entry.categories, recipeMap);
    collectRecipesFromCategories(entry.subcategories, recipeMap);
  }
}

function extractKnownRecipes(payload: unknown): Array<{ id: number; name: string }> {
  const node = (payload ?? {}) as {
    known_recipes?: unknown[];
    skill_tiers?: Array<{ known_recipes?: unknown[] }>;
    tiers?: Array<{ known_recipes?: unknown[]; recipes?: unknown[]; categories?: unknown[]; subcategories?: unknown[] }>;
    categories?: Array<{ known_recipes?: unknown[]; recipes?: unknown[] }>;
    recipes?: unknown[];
  };

  const recipeMap = new Map<number, string>();
  collectRecipesFromArray(node.known_recipes, recipeMap);
  collectRecipesFromArray(node.recipes, recipeMap);
  collectRecipesFromCategories(node.categories, recipeMap);

  for (const tier of node.skill_tiers ?? []) {
    collectRecipesFromArray(tier.known_recipes, recipeMap);
    collectRecipesFromCategories((tier as { categories?: unknown[]; subcategories?: unknown[] }).categories, recipeMap);
    collectRecipesFromCategories((tier as { categories?: unknown[]; subcategories?: unknown[] }).subcategories, recipeMap);
  }

  for (const tier of node.tiers ?? []) {
    collectRecipesFromArray(tier.known_recipes, recipeMap);
    collectRecipesFromArray(tier.recipes, recipeMap);
    collectRecipesFromCategories(tier.categories, recipeMap);
    collectRecipesFromCategories(tier.subcategories, recipeMap);
  }

  return Array.from(recipeMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getStatus(db: D1Database): Promise<ProfessionsPageStatus> {
  const now = nowInSeconds();

  const [rosterCountRow, syncSummaryRow] = await db.batch([
    db.prepare('SELECT COUNT(*) AS roster_count FROM roster_members_cache'),
    db.prepare(
      `SELECT
         COUNT(*) AS synced_count,
         SUM(CASE WHEN last_synced_at IS NULL OR last_synced_at < ? THEN 1 ELSE 0 END) AS stale_count,
         MIN(last_synced_at) AS oldest_sync,
         MAX(last_synced_at) AS newest_sync
       FROM profession_character_sync_cache`
    ).bind(now - SYNC_TTL_SECONDS),
  ]);

  const rosterCount = Number((rosterCountRow.results?.[0] as { roster_count?: number } | undefined)?.roster_count ?? 0);
  const syncSummary = (syncSummaryRow.results?.[0] as {
    synced_count?: number;
    stale_count?: number;
    oldest_sync?: number | null;
    newest_sync?: number | null;
  } | undefined) ?? {};

  return {
    rosterCount,
    syncedCount: Number(syncSummary.synced_count ?? 0),
    staleCount: Number(syncSummary.stale_count ?? 0),
    oldestSync: syncSummary.oldest_sync ?? null,
    newestSync: syncSummary.newest_sync ?? null,
  };
}

async function pruneOrphans(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM profession_recipe_owners_cache
       WHERE blizzard_char_id NOT IN (SELECT blizzard_char_id FROM roster_members_cache)`
    ),
    db.prepare(
      `DELETE FROM profession_character_sync_cache
       WHERE blizzard_char_id NOT IN (SELECT blizzard_char_id FROM roster_members_cache)`
    ),
  ]);
}

async function loadProfessionIconUrls(professionIds: number[]): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  const uniqueIds = Array.from(new Set(professionIds.filter((id) => Number.isFinite(id) && id > 0)));

  if (uniqueIds.length === 0) {
    return result;
  }

  const missingIds = uniqueIds.filter((id) => !professionIconUrlCache.has(id));
  if (missingIds.length > 0 && env.BLIZZARD_CLIENT_ID && env.BLIZZARD_CLIENT_SECRET) {
    const accessToken = await getBlizzardAppAccessToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);

    if (accessToken) {
      await Promise.all(
        missingIds.map(async (professionId) => {
          try {
            const staticUrl = `${API_BASE}/data/wow/profession/${professionId}?namespace=${STATIC_NAMESPACE}&locale=${LOCALE}`;
            const staticPayload = await fetchBlizzardJsonWithRetry<ProfessionStaticResponse>(staticUrl, accessToken);
            const mediaHref = staticPayload?.media?.key?.href;

            if (!mediaHref) {
              professionIconUrlCache.set(professionId, null);
              return;
            }

            const mediaUrl = mediaHref.includes('locale=') ? mediaHref : `${mediaHref}&locale=${LOCALE}`;
            const mediaPayload = await fetchBlizzardJsonWithRetry<ProfessionMediaResponse>(mediaUrl, accessToken);
            const iconUrl =
              mediaPayload?.assets?.find((asset) => String(asset.key ?? '').toLowerCase() === 'icon')?.value ?? null;

            professionIconUrlCache.set(professionId, iconUrl);
          } catch {
            professionIconUrlCache.set(professionId, null);
          }
        })
      );
    }
  }

  for (const professionId of uniqueIds) {
    result.set(professionId, professionIconUrlCache.get(professionId) ?? null);
  }

  return result;
}

export async function refreshProfessionsCache(
  dbInput?: D1Database,
  options?: ProfessionsRefreshOptions
): Promise<ProfessionsRefreshResult> {
  const db = getDatabase(dbInput);
  const batchSize = parsePositiveInteger(options?.batchSize, DEFAULT_BATCH_SIZE);
  const diagnostics: ProfessionsRefreshDiagnostics = {
    candidatesSelected: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    recipesStored: 0,
  };

  await pruneOrphans(db);

  if (!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) {
    return {
      diagnostics,
      status: await getStatus(db),
    };
  }

  const accessToken = await getBlizzardAppAccessToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);
  if (!accessToken) {
    return {
      diagnostics,
      status: await getStatus(db),
    };
  }

  const now = nowInSeconds();

  const candidateResult = await db
    .prepare(
      `SELECT
          r.blizzard_char_id,
          r.name,
          r.realm_slug,
          r.rank
       FROM roster_members_cache r
       LEFT JOIN profession_character_sync_cache s
         ON s.blizzard_char_id = r.blizzard_char_id
       WHERE s.last_synced_at IS NULL OR s.last_synced_at < ?
       ORDER BY s.last_synced_at IS NOT NULL, s.last_synced_at ASC, r.rank ASC, r.name ASC
       LIMIT ?`
    )
    .bind(now - SYNC_TTL_SECONDS, batchSize)
    .all<RosterMemberRow>();

  const candidates = (candidateResult.results ?? []) as RosterMemberRow[];
  diagnostics.candidatesSelected = candidates.length;

  for (const candidate of candidates) {
    const charId = Number(candidate.blizzard_char_id);
    const charName = String(candidate.name ?? '').trim();
    const realmSlug = String(candidate.realm_slug ?? '').trim();

    if (!charId || !charName || !realmSlug) {
      diagnostics.skipped += 1;
      continue;
    }

    const normalizedName = normalizeCharacterNameForPath(charName);
    const summaryUrl = `${API_BASE}/profile/wow/character/${encodeURIComponent(realmSlug)}/${normalizedName}/professions?namespace=${PROFILE_NAMESPACE}&locale=${LOCALE}`;
    const summary = await fetchBlizzardJsonWithRetry<CharacterProfessionSummaryResponse>(summaryUrl, accessToken);

    if (!summary) {
      diagnostics.failed += 1;
      await db
        .prepare(
          `INSERT INTO profession_character_sync_cache (
              blizzard_char_id,
              character_name,
              realm_slug,
              profession_count,
              recipe_count,
              last_status,
              last_error,
              last_synced_at,
              updated_at
           ) VALUES (?, ?, ?, 0, 0, 'error', ?, ?, ?)
           ON CONFLICT(blizzard_char_id) DO UPDATE SET
              character_name = excluded.character_name,
              realm_slug = excluded.realm_slug,
              profession_count = excluded.profession_count,
              recipe_count = excluded.recipe_count,
              last_status = excluded.last_status,
              last_error = excluded.last_error,
              last_synced_at = excluded.last_synced_at,
              updated_at = excluded.updated_at`
        )
        .bind(charId, charName, realmSlug, 'Unable to fetch professions summary', now, now)
        .run();
      continue;
    }

    const professions = extractProfessions(summary);
    let recipeInsertCount = 0;

    await db
      .prepare('DELETE FROM profession_recipe_owners_cache WHERE blizzard_char_id = ?')
      .bind(charId)
      .run();

    for (const profession of professions) {
      const recipes = extractKnownRecipes(profession.payload);
      for (const recipe of recipes) {
        await db
          .prepare(
            `INSERT INTO profession_recipe_owners_cache (
                blizzard_char_id,
                character_name,
                realm_slug,
                profession_id,
                profession_name,
                recipe_id,
                recipe_name,
                synced_at,
                updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            charId,
            charName,
            realmSlug,
            profession.id,
            profession.name,
            recipe.id,
            recipe.name,
            now,
            now
          )
          .run();
        recipeInsertCount += 1;
      }
    }

    await db
      .prepare(
        `INSERT INTO profession_character_sync_cache (
            blizzard_char_id,
            character_name,
            realm_slug,
            profession_count,
            recipe_count,
            last_status,
            last_error,
            last_synced_at,
            updated_at
         ) VALUES (?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
         ON CONFLICT(blizzard_char_id) DO UPDATE SET
            character_name = excluded.character_name,
            realm_slug = excluded.realm_slug,
            profession_count = excluded.profession_count,
            recipe_count = excluded.recipe_count,
            last_status = excluded.last_status,
            last_error = excluded.last_error,
            last_synced_at = excluded.last_synced_at,
            updated_at = excluded.updated_at`
      )
      .bind(charId, charName, realmSlug, professions.length, recipeInsertCount, now, now)
      .run();

    diagnostics.synced += 1;
    diagnostics.recipesStored += recipeInsertCount;
  }

  return {
    diagnostics,
    status: await getStatus(db),
  };
}

export async function loadProfessionsPageData(
  selectedProfessionId: number | null,
  selectedRecipeId: number | null,
  dbInput?: D1Database
): Promise<ProfessionsPageData> {
  const db = getDatabase(dbInput);

  await refreshProfessionsCache(db);

  const professionRowsResult = await db
    .prepare(
      `SELECT
          p.profession_id,
          p.profession_name,
          COUNT(DISTINCT p.blizzard_char_id) AS owner_count,
          COUNT(DISTINCT p.recipe_id) AS recipe_count
       FROM profession_recipe_owners_cache p
       INNER JOIN roster_members_cache r
         ON r.blizzard_char_id = p.blizzard_char_id
       GROUP BY p.profession_id, p.profession_name
       ORDER BY LOWER(p.profession_name) ASC`
    )
    .all<ProfessionListRow>();

  const professionRows = (professionRowsResult.results ?? []) as ProfessionListRow[];
  const professionIconMap = await loadProfessionIconUrls(professionRows.map((row) => row.profession_id));

  const professions = professionRows.map((row) => ({
    professionId: row.profession_id,
    professionName: row.profession_name,
    ownerCount: Number(row.owner_count ?? 0),
    recipeCount: Number(row.recipe_count ?? 0),
    iconUrl: professionIconMap.get(row.profession_id) ?? null,
  }));

  const selectedProfession =
    selectedProfessionId !== null
      ? professions.find((row) => row.professionId === selectedProfessionId) ?? null
      : null;

  let recipes: RecipeSummaryResult[] = [];
  if (selectedProfession) {
    const recipeRowsResult = await db
      .prepare(
        `SELECT
            p.recipe_id,
            p.recipe_name,
            COUNT(DISTINCT p.blizzard_char_id) AS owner_count
         FROM profession_recipe_owners_cache p
         INNER JOIN roster_members_cache r
           ON r.blizzard_char_id = p.blizzard_char_id
         WHERE p.profession_id = ?
         GROUP BY p.recipe_id, p.recipe_name
         ORDER BY owner_count DESC, LOWER(p.recipe_name) ASC`
      )
      .bind(selectedProfession.professionId)
      .all<RecipeListRow>();

    recipes = ((recipeRowsResult.results ?? []) as RecipeListRow[]).map((row) => ({
      recipeId: row.recipe_id,
      recipeName: row.recipe_name,
      ownerCount: Number(row.owner_count ?? 0),
    }));
  }

  const selectedRecipe =
    selectedRecipeId !== null ? recipes.find((row) => row.recipeId === selectedRecipeId) ?? null : null;

  let owners: RecipeOwnerResult[] = [];
  if (selectedProfession && selectedRecipe) {
    const ownerRowsResult = await db
      .prepare(
        `SELECT
            p.blizzard_char_id,
            p.character_name,
            p.realm_slug
         FROM profession_recipe_owners_cache p
         INNER JOIN roster_members_cache r
           ON r.blizzard_char_id = p.blizzard_char_id
         WHERE p.profession_id = ?
           AND p.recipe_id = ?
         ORDER BY LOWER(p.character_name) ASC, LOWER(p.realm_slug) ASC`
      )
      .bind(selectedProfession.professionId, selectedRecipe.recipeId)
      .all<RecipeOwnerRow>();

    owners = ((ownerRowsResult.results ?? []) as RecipeOwnerRow[]).map((row) => ({
      blizzardCharId: row.blizzard_char_id,
      characterName: row.character_name,
      realmSlug: row.realm_slug,
    }));
  }

  return {
    status: await getStatus(db),
    professions,
    selectedProfession,
    recipes,
    selectedRecipe,
    owners,
  };
}
