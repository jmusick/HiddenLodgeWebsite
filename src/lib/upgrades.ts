import type { D1Database } from '@cloudflare/workers-types';
import midnightJournalData from '../data/midnight-journal-data.json';

const RAIDBOTS_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const LODGESIM_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

const SINGLE_TARGET_RUNNER_SQL =
  "(sr.runner_version = 'wowsim-website-runner-v1-single-target' OR sr.runner_version LIKE '%single-target%' OR sr.runner_version LIKE '%single_target%')";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ─── Static Midnight Season 1 raid config ────────────────────────────────────

export const MIDNIGHT_S1_RAIDS = [
  { slug: 'voidspire',  name: 'The Voidspire' },
  { slug: 'dreamrift',  name: 'The Dreamrift' },
  { slug: 'queldanas',  name: "March on Quel'Danas" },
] as const;

export type RaidSlug = (typeof MIDNIGHT_S1_RAIDS)[number]['slug'];

export const RAID_SLUG_TO_NAME: Record<string, string> = Object.fromEntries(
  MIDNIGHT_S1_RAIDS.map((r) => [r.slug, r.name])
);

export interface JournalBoss {
  encounterId: number;
  name: string;
  itemIds: number[];
}

export interface JournalRaid {
  raidSlug: string;
  raidName: string;
  bosses: JournalBoss[];
}

export async function fetchJournalRaidData(
  _clientId: string | undefined,
  _clientSecret: string | undefined
): Promise<JournalRaid[]> {
  return midnightJournalData as JournalRaid[];
}

// ─── Upgrade data types ───────────────────────────────────────────────────────

export interface RaiderUpgradeEntry {
  charId: number;
  charName: string;
  charClass: string;
  deltaDps: number;
  pctGain: number | null;
  source: 'Raidbots' | 'LodgeSim';
  raidSlug: string | null;
}

export interface ItemUpgrades {
  itemId: number;
  itemLabel: string | null;
  slot: string | null;
  ilvl: number | null;
  itemIconUrl: string | null;
  raidSlug: string | null;
  raiders: RaiderUpgradeEntry[];
  totalTeamDps: number;
}

export interface UpgradesPageData {
  difficulty: 'heroic' | 'mythic';
  journalRaids: JournalRaid[];
  items: ItemUpgrades[];
  hasRaidbotsData: boolean;
  hasLodgeSimData: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferRaidSlugFromSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const lower = source.toLowerCase();
  if (lower.includes('voidspire')) return 'voidspire';
  if (lower.includes('dreamrift')) return 'dreamrift';
  if (lower.includes("quel'danas") || lower.includes('queldanas')) return 'queldanas';
  return null;
}

async function getDBTableNames(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set((rows.results ?? []).map((r) => r.name));
}

type BlizzardTokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

const itemIconMemoryCache = new Map<number, string>();
let tokenCache: BlizzardTokenCache | null = null;

async function fetchWowheadIconUrl(itemId: number): Promise<string | null> {
  try {
    const res = await fetch(`https://www.wowhead.com/item=${itemId}&xml`);
    if (!res.ok) return null;

    const xml = await res.text();
    const iconMatch = xml.match(/<icon(?:\s[^>]*)?>([^<]+)<\/icon>/i);
    const iconName = iconMatch?.[1]?.trim();
    if (!iconName) return null;

    return `https://wow.zamimg.com/images/wow/icons/large/${iconName.toLowerCase()}.jpg`;
  } catch {
    return null;
  }
}

async function getBlizzardAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 60_000) {
    return tokenCache.accessToken;
  }

  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const auth = btoa(`${clientId}:${clientSecret}`);
    const res = await fetch('https://oauth.battle.net/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;

    const expiresInMs = Math.max(60, Number(json.expires_in ?? 3600)) * 1000;
    tokenCache = {
      accessToken: json.access_token,
      expiresAtMs: now + expiresInMs,
    };
    return json.access_token;
  } catch {
    return null;
  }
}

async function fetchItemIconUrls(
  db: D1Database,
  itemIds: number[],
  clientId: string | undefined,
  clientSecret: string | undefined
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const validIds = itemIds.filter((id) => Number.isFinite(id) && id > 0);
  if (validIds.length === 0) return result;

  // 1. Serve from in-memory cache (within-request deduplication).
  for (const id of validIds) {
    if (itemIconMemoryCache.has(id)) result.set(id, itemIconMemoryCache.get(id)!);
  }
  const notInMemory = validIds.filter((id) => !itemIconMemoryCache.has(id));
  if (notInMemory.length === 0) return result;

  // 2. Check persistent DB cache (survives worker restarts, avoids repeat API calls).
  const hasIconTable = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_icon_cache' LIMIT 1")
    .first<{ '1': number }>();

  // D1 limits bound parameters to 100 per query — chunk the lookup.
  if (hasIconTable) {
    const CHUNK = 90;
    for (let i = 0; i < notInMemory.length; i += CHUNK) {
      const chunk = notInMemory.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const dbRows = await db
        .prepare(`SELECT item_id, icon_url FROM item_icon_cache WHERE item_id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ item_id: number; icon_url: string }>();
      for (const row of dbRows.results ?? []) {
        result.set(row.item_id, row.icon_url);
        itemIconMemoryCache.set(row.item_id, row.icon_url);
      }
    }
  }

  // 3. Fetch remaining items from Blizzard API and persist them.
  const needsApi = notInMemory.filter((id) => !result.has(id));
  if (needsApi.length === 0 || !clientId || !clientSecret) return result;

  const token = await getBlizzardAccessToken(clientId, clientSecret);
  if (!token) return result;

  const freshIcons: Array<{ item_id: number; icon_url: string }> = [];

  await Promise.all(
    needsApi.map(async (itemId) => {
      try {
        const mediaRes = await fetch(
          `https://us.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-us&locale=en_US`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!mediaRes.ok) return;

        const mediaJson = (await mediaRes.json()) as {
          assets?: Array<{ key?: string; value?: string }>;
        };
        const rawUrl =
          mediaJson.assets?.find((asset) => asset.key === 'icon')?.value ??
          mediaJson.assets?.[0]?.value ??
          null;
        if (!rawUrl) return;

        // Normalise to zamimg CDN — more reliably publicly accessible.
        const match = rawUrl.match(/\/icons\/\d+\/([^/?#]+)/);
        const iconUrl = match
          ? `https://wow.zamimg.com/images/wow/icons/large/${match[1]}`
          : rawUrl;

        result.set(itemId, iconUrl);
        itemIconMemoryCache.set(itemId, iconUrl);
        freshIcons.push({ item_id: itemId, icon_url: iconUrl });
      } catch {
        // Leave this item without an icon for this request; it'll be retried next time.
      }
    })
  );

  // 4. Fallback to Wowhead XML icon metadata for any unresolved IDs.
  const stillMissing = needsApi.filter((id) => !result.has(id));
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (itemId) => {
        const wowheadIcon = await fetchWowheadIconUrl(itemId);
        if (!wowheadIcon) return;
        result.set(itemId, wowheadIcon);
        itemIconMemoryCache.set(itemId, wowheadIcon);
        freshIcons.push({ item_id: itemId, icon_url: wowheadIcon });
      })
    );
  }

  // Persist fresh icons to DB so they don't need to be fetched again.
  if (hasIconTable && freshIcons.length > 0) {
    const now = nowSeconds();
    for (const icon of freshIcons) {
      await db
        .prepare(
          'INSERT OR REPLACE INTO item_icon_cache (item_id, icon_url, fetched_at) VALUES (?, ?, ?)'
        )
        .bind(icon.item_id, icon.icon_url, now)
        .run();
    }
  }

  return result;
}

// ─── Main data query ──────────────────────────────────────────────────────────

export async function getAllRaiderUpgrades(
  db: D1Database,
  difficulty: 'heroic' | 'mythic'
): Promise<{ items: ItemUpgrades[]; hasRaidbotsData: boolean; hasLodgeSimData: boolean }> {
  const tables = await getDBTableNames(db);
  const canUseRaidbots =
    tables.has('sim_raidbots_item_scores') && tables.has('sim_raidbots_reports');
  const canUseLodgeSim =
    tables.has('sim_runs') &&
    (tables.has('sim_item_scores') || tables.has('sim_item_winners'));

  const itemsByItemId = new Map<number, ItemUpgrades>();
  const raidbotsCharItemKeys = new Set<string>(); // `${charId}|${itemId}` covered by Raidbots
  let hasRaidbotsData = false;
  let hasLodgeSimData = false;

  const now = nowSeconds();

  // ─── Step 1: Raidbots (primary) ───────────────────────────────────────────
  if (canUseRaidbots) {
    const colRows = await db
      .prepare('PRAGMA table_info(sim_raidbots_item_scores)')
      .all<{ name: string }>();
    const hasItemLabel = (colRows.results ?? []).some((r) => r.name === 'item_label');

    type RbRow = {
      blizzard_char_id: number;
      char_name: string;
      class_name: string;
      item_id: number;
      item_label: string | null;
      delta_dps: number;
      pct_gain: number | null;
      slot: string | null;
      ilvl: number | null;
      difficulty: string;
      raid_slug: string | null;
      fetched_at: number;
    };

    const rbResult = await db
      .prepare(
        `SELECT
           sis.blizzard_char_id,
           rmc.name AS char_name,
           rmc.class_name,
           sis.item_id,
           ${hasItemLabel ? 'sis.item_label,' : 'NULL AS item_label,'}
           sis.delta_dps,
           sis.pct_gain,
           sis.slot,
           sis.ilvl,
           LOWER(COALESCE(sis.difficulty, srr.difficulty)) AS difficulty,
           srr.raid_slug,
           srr.fetched_at
         FROM sim_raidbots_item_scores sis
         JOIN sim_raidbots_reports srr ON srr.id = sis.raidbots_report_id
         JOIN roster_members_cache rmc ON rmc.blizzard_char_id = sis.blizzard_char_id
         WHERE srr.status = 'ok'
           AND srr.fetched_at >= ?
           AND sis.item_id IS NOT NULL
           AND LOWER(COALESCE(sis.difficulty, srr.difficulty)) = ?
         ORDER BY srr.fetched_at DESC`
      )
      .bind(now - RAIDBOTS_MAX_AGE_SECONDS, difficulty)
      .all<RbRow>();

    // Keep best delta per char+item across all reports.
    const bestByCharItem = new Map<string, RbRow>();
    for (const row of rbResult.results ?? []) {
      const key = `${row.blizzard_char_id}|${row.item_id}`;
      const existing = bestByCharItem.get(key);
      if (!existing || Number(row.delta_dps) > Number(existing.delta_dps)) {
        bestByCharItem.set(key, row);
      }
    }

    for (const [key, row] of bestByCharItem) {
      const itemId = Number(row.item_id);
      const delta = Number(row.delta_dps);
      if (!Number.isFinite(delta) || itemId <= 0) continue;

      raidbotsCharItemKeys.add(key);
      hasRaidbotsData = true;

      if (!itemsByItemId.has(itemId)) {
        itemsByItemId.set(itemId, {
          itemId,
          itemLabel: row.item_label ? String(row.item_label) : null,
          slot: row.slot ? String(row.slot) : null,
          ilvl: row.ilvl != null ? Number(row.ilvl) : null,
          itemIconUrl: null,
          raidSlug: row.raid_slug ? String(row.raid_slug) : null,
          raiders: [],
          totalTeamDps: 0,
        });
      }
      const item = itemsByItemId.get(itemId)!;
      if (!item.itemLabel && row.item_label) item.itemLabel = String(row.item_label);

      item.raiders.push({
        charId: Number(row.blizzard_char_id),
        charName: String(row.char_name ?? ''),
        charClass: String(row.class_name ?? ''),
        deltaDps: delta,
        pctGain: row.pct_gain != null ? Number(row.pct_gain) : null,
        source: 'Raidbots',
        raidSlug: row.raid_slug ? String(row.raid_slug) : null,
      });
      item.totalTeamDps += delta;
    }
  }

  // ─── Step 2: LodgeSim (fallback for gaps) ────────────────────────────────
  // Each passive sim run contains only one raider's data, so we must aggregate
  // across all recent runs — taking the most recent run per raider — rather
  // than querying a single run that would only show one raider.
  if (canUseLodgeSim) {
    let addedFromScores = false;

    if (tables.has('sim_item_scores')) {
      // Deduplicate per char+item, keeping best delta.
      type LsRow = {
        blizzard_char_id: number;
        char_name: string;
        class_name: string;
        item_id: number;
        item_label: string | null;
        delta_dps: number;
        pct_gain: number | null;
        slot: string | null;
        ilvl: number | null;
        source: string | null;
      };

      // Subquery finds the most recently created run (MAX id) per raider, then
      // joins back to retrieve that raider's item scores.
      const lsResult = await db
        .prepare(
          `SELECT
             sis.blizzard_char_id,
             rmc.name AS char_name,
             rmc.class_name,
             sis.item_id,
             sis.item_label,
             sis.delta_dps,
             sis.pct_gain,
             sis.slot,
             sis.ilvl,
             sis.source
           FROM sim_item_scores sis
           JOIN sim_runs sr ON sr.id = sis.sim_run_id
           JOIN roster_members_cache rmc ON rmc.blizzard_char_id = sis.blizzard_char_id
           JOIN (
             SELECT sis2.blizzard_char_id, MAX(sr2.id) AS latest_run_id
             FROM sim_item_scores sis2
             JOIN sim_runs sr2 ON sr2.id = sis2.sim_run_id
             WHERE sr2.status = 'finished'
               AND sr2.updated_at >= ?
               AND LOWER(sr2.difficulty) = ?
               AND NOT (sr2.runner_version = 'wowsim-website-runner-v1-single-target' OR sr2.runner_version LIKE '%single-target%' OR sr2.runner_version LIKE '%single_target%')
             GROUP BY sis2.blizzard_char_id
           ) latest_runs
             ON latest_runs.blizzard_char_id = sis.blizzard_char_id
            AND sr.id = latest_runs.latest_run_id
           WHERE sis.item_id IS NOT NULL
           ORDER BY sis.delta_dps DESC`
        )
        .bind(now - LODGESIM_MAX_AGE_SECONDS, difficulty)
        .all<LsRow>();

      const bestLsScores = new Map<string, LsRow>();
      for (const row of lsResult.results ?? []) {
        const key = `${row.blizzard_char_id}|${row.item_id}`;
        const existing = bestLsScores.get(key);
        if (!existing || Number(row.delta_dps) > Number(existing.delta_dps)) {
          bestLsScores.set(key, row);
        }
      }

      for (const row of bestLsScores.values()) {
        const itemId = Number(row.item_id);
        const delta = Number(row.delta_dps);
        if (!Number.isFinite(delta) || itemId <= 0) continue;

        const charItemKey = `${row.blizzard_char_id}|${itemId}`;
        if (raidbotsCharItemKeys.has(charItemKey)) continue;

        addedFromScores = true;
        hasLodgeSimData = true;
        const raidSlug = inferRaidSlugFromSource(row.source);

        if (!itemsByItemId.has(itemId)) {
          itemsByItemId.set(itemId, {
            itemId,
            itemLabel: row.item_label ? String(row.item_label) : null,
            slot: row.slot ? String(row.slot) : null,
            ilvl: row.ilvl != null ? Number(row.ilvl) : null,
            itemIconUrl: null,
            raidSlug,
            raiders: [],
            totalTeamDps: 0,
          });
        }
        const item = itemsByItemId.get(itemId)!;
        item.raiders.push({
          charId: Number(row.blizzard_char_id),
          charName: String(row.char_name ?? ''),
          charClass: String(row.class_name ?? ''),
          deltaDps: delta,
          pctGain: row.pct_gain != null ? Number(row.pct_gain) : null,
          source: 'LodgeSim',
          raidSlug,
        });
        item.totalTeamDps += delta;
      }
    }

    // Fallback to sim_item_winners if sim_item_scores had nothing useful.
    if (!addedFromScores && tables.has('sim_item_winners')) {
      type WinRow = {
        best_blizzard_char_id: number;
        char_name: string;
        class_name: string;
        item_id: number;
        item_label: string | null;
        delta_dps: number;
        pct_gain: number | null;
        slot: string | null;
        ilvl: number | null;
        source: string | null;
      };

      // Same per-raider latest-run approach for winners.
      const winResult = await db
        .prepare(
          `SELECT
             siw.best_blizzard_char_id,
             rmc.name AS char_name,
             rmc.class_name,
             siw.item_id,
             siw.item_label,
             siw.delta_dps,
             siw.pct_gain,
             siw.slot,
             siw.ilvl,
             siw.source
           FROM sim_item_winners siw
           JOIN sim_runs sr ON sr.id = siw.sim_run_id
           JOIN roster_members_cache rmc ON rmc.blizzard_char_id = siw.best_blizzard_char_id
           JOIN (
             SELECT siw2.best_blizzard_char_id, MAX(sr2.id) AS latest_run_id
             FROM sim_item_winners siw2
             JOIN sim_runs sr2 ON sr2.id = siw2.sim_run_id
             WHERE sr2.status = 'finished'
               AND sr2.updated_at >= ?
               AND LOWER(sr2.difficulty) = ?
               AND NOT (sr2.runner_version = 'wowsim-website-runner-v1-single-target' OR sr2.runner_version LIKE '%single-target%' OR sr2.runner_version LIKE '%single_target%')
               AND siw2.best_blizzard_char_id IS NOT NULL
             GROUP BY siw2.best_blizzard_char_id
           ) latest_runs
             ON latest_runs.best_blizzard_char_id = siw.best_blizzard_char_id
            AND sr.id = latest_runs.latest_run_id
           WHERE siw.item_id IS NOT NULL
             AND siw.best_blizzard_char_id IS NOT NULL
           ORDER BY siw.delta_dps DESC`
        )
        .bind(now - LODGESIM_MAX_AGE_SECONDS, difficulty)
        .all<WinRow>();

      const bestWinScores = new Map<string, WinRow>();
      for (const row of winResult.results ?? []) {
        const itemId = Number(row.item_id);
        const charId = Number(row.best_blizzard_char_id);
        const delta = Number(row.delta_dps);
        if (!Number.isFinite(delta) || itemId <= 0 || !Number.isFinite(charId)) continue;
        const charItemKey = `${charId}|${itemId}`;
        if (raidbotsCharItemKeys.has(charItemKey)) continue;
        const existing = bestWinScores.get(charItemKey);
        if (!existing || delta > Number(existing.delta_dps)) {
          bestWinScores.set(charItemKey, row);
        }
      }

      for (const [, row] of bestWinScores) {
        const itemId = Number(row.item_id);
        const charId = Number(row.best_blizzard_char_id);
        const delta = Number(row.delta_dps);
        hasLodgeSimData = true;
        const raidSlug = inferRaidSlugFromSource(row.source);

        if (!itemsByItemId.has(itemId)) {
          itemsByItemId.set(itemId, {
            itemId,
            itemLabel: row.item_label ? String(row.item_label) : null,
            slot: row.slot ? String(row.slot) : null,
            ilvl: row.ilvl != null ? Number(row.ilvl) : null,
            itemIconUrl: null,
            raidSlug,
            raiders: [],
            totalTeamDps: 0,
          });
        }
        const item = itemsByItemId.get(itemId)!;
        item.raiders.push({
          charId,
          charName: String(row.char_name ?? ''),
          charClass: String(row.class_name ?? ''),
          deltaDps: delta,
          pctGain: row.pct_gain != null ? Number(row.pct_gain) : null,
          source: 'LodgeSim',
          raidSlug,
        });
        item.totalTeamDps += delta;
      }
    }
  }

  // Drop downgrade/neutral raider rows and recalculate team DPS totals.
  for (const item of itemsByItemId.values()) {
    item.raiders = item.raiders.filter((r) => r.deltaDps > 0);
    item.totalTeamDps = item.raiders.reduce((sum, r) => sum + r.deltaDps, 0);
    item.raiders.sort((a, b) => b.deltaDps - a.deltaDps);
  }

  // Drop items with no remaining upgrade raiders.
  const items = [...itemsByItemId.values()]
    .filter((item) => item.raiders.length > 0)
    .sort((a, b) => b.totalTeamDps - a.totalTeamDps);
  return { items, hasRaidbotsData, hasLodgeSimData };
}

export async function loadUpgradesPageData(
  db: D1Database,
  difficulty: 'heroic' | 'mythic',
  blizzardClientId: string | undefined,
  blizzardClientSecret: string | undefined
): Promise<UpgradesPageData> {
  const [upgradeData, journalRaids] = await Promise.all([
    getAllRaiderUpgrades(db, difficulty),
    fetchJournalRaidData(blizzardClientId, blizzardClientSecret),
  ]);

  const iconMap = await fetchItemIconUrls(
    db,
    upgradeData.items.map((item) => item.itemId),
    blizzardClientId,
    blizzardClientSecret
  );

  const itemsWithIcons = upgradeData.items.map((item) => ({
    ...item,
    itemIconUrl: iconMap.get(item.itemId) ?? null,
  }));

  return {
    difficulty,
    journalRaids,
    ...upgradeData,
    items: itemsWithIcons,
  };
}
