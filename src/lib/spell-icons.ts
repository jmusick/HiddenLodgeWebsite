import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { getBlizzardAppAccessToken } from './blizzard-app-token';

// Spell icon lookup for the Death Analysis defensive-cooldown estimate,
// mirroring the item_icon_cache pattern in src/lib/upgrades.ts (D1 cache in
// front of Blizzard's media API) but for spells and without the Wowhead
// fallback — the ability list here is small and hand-maintained, so a miss
// just means no icon for that entry rather than a gear-upgrade calculation
// going wrong.

const API_BASE = 'https://us.api.blizzard.com';
const STATIC_NAMESPACE = 'static-us';
const LOCALE = 'en_US';

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

async function fetchSpellIconFromBlizzard(spellId: number, accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/data/wow/media/spell/${spellId}?namespace=${STATIC_NAMESPACE}&locale=${LOCALE}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { assets?: Array<{ key?: string; value?: string }> };
    const icon = payload.assets?.find((asset) => (asset.key ?? '').toLowerCase() === 'icon');
    return icon?.value?.trim() || null;
  } catch {
    return null;
  }
}

/** Looks up icon URLs for the given spell ids, layering D1 cache in front of the Blizzard media API. */
export async function fetchSpellIconUrls(spellIds: number[], dbInput?: D1Database): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(spellIds.filter((id) => Number.isInteger(id) && id > 0))];
  const result = new Map<number, string>();
  if (uniqueIds.length === 0) return result;

  const db = getDatabase(dbInput);
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const cachedResult = await db
    .prepare(`SELECT spell_id, icon_url FROM spell_icon_cache WHERE spell_id IN (${placeholders})`)
    .bind(...uniqueIds)
    .all<{ spell_id: number; icon_url: string }>();
  for (const row of cachedResult.results ?? []) {
    result.set(row.spell_id, row.icon_url);
  }

  const missingIds = uniqueIds.filter((id) => !result.has(id));
  if (missingIds.length === 0) return result;

  const clientId = (env.BLIZZARD_CLIENT_ID ?? '').trim();
  const clientSecret = (env.BLIZZARD_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return result;
  const accessToken = await getBlizzardAppAccessToken(clientId, clientSecret);
  if (!accessToken) return result;

  const now = nowInSeconds();
  const fetched = await Promise.all(
    missingIds.map(async (spellId) => ({ spellId, iconUrl: await fetchSpellIconFromBlizzard(spellId, accessToken) }))
  );

  const statements = [];
  for (const { spellId, iconUrl } of fetched) {
    if (!iconUrl) continue;
    result.set(spellId, iconUrl);
    statements.push(
      db.prepare('INSERT OR REPLACE INTO spell_icon_cache (spell_id, icon_url, fetched_at) VALUES (?, ?, ?)').bind(spellId, iconUrl, now)
    );
  }
  if (statements.length > 0) await db.batch(statements);

  return result;
}
