export interface RaidbotsItemScore {
  itemId: number;
  itemLabel: string | null;
  deltaDps: number;
  pctGain: number | null;
  slot: string | null;
  ilvl: number | null;
  difficulty: 'heroic' | 'mythic' | null;
}

export interface RaidbotsReportData {
  reportId: string;
  characterName: string;
  realm: string;
  difficulty: 'heroic' | 'mythic' | null;
  raidSlug: string | null;
  title: string | null;
  baselineDps: number;
  scores: RaidbotsItemScore[];
  config: {
    maxTrackUpgrades: boolean;
    upgradeAllEquipped: boolean | null;
  };
}

const RAID_TITLE_TO_SLUG: Record<string, string> = {
  "march on quel'danas": 'queldanas',
  'march on queldanas':  'queldanas',
  'the voidspire':       'voidspire',
  'the dreamrift':       'dreamrift',
};

export function extractReportId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  // Full URL: .../report/XXXX or .../reports/XXXX/...
  const urlMatch = trimmed.match(/(?:report|reports)\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  // Bare ID: only alphanumeric + dash/underscore
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

function parseCharacterFromSimc(text: string): { name: string; realm: string } {
  // First quoted assignment is the character name: hunter="Beastndesist"
  const nameMatch = text.match(/^[\w]+\s*=\s*"([^"]+)"/m);
  const realmMatch = text.match(/^server\s*=\s*(\S+)/m);
  return {
    name:  nameMatch  ? nameMatch[1].trim()  : '',
    realm: realmMatch ? realmMatch[1].trim() : '',
  };
}

function parseRaidSlugFromTitle(title: string): string | null {
  // "Droptimizer • March on Quel'Danas • Heroic • Hero 6/6"
  const parts = title.split('•').map((p) => p.trim());
  for (const part of parts) {
    const slug = RAID_TITLE_TO_SLUG[part.toLowerCase()];
    if (slug) return slug;
  }
  return null;
}

function parseDifficultyFromTitle(title: string): 'heroic' | 'mythic' | null {
  const parts = title.split('•').map((p) => p.trim().toLowerCase());
  if (parts.includes('mythic')) return 'mythic';
  if (parts.includes('heroic')) return 'heroic';
  return null;
}

function parseDifficultyFromProfilesetName(name: string): 'heroic' | 'mythic' | null {
  if (name.includes('raid-mythic')) return 'mythic';
  if (name.includes('raid-heroic')) return 'heroic';
  return null;
}

function buildDroptimizerItemNameMap(rawFormData: Record<string, unknown> | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  const rawItems = rawFormData?.droptimizerItems;
  if (!Array.isArray(rawItems)) return out;

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const item = (entry as Record<string, unknown>).item;
    if (!item || typeof item !== 'object') continue;
    const itemId = Number((item as Record<string, unknown>).id ?? NaN);
    const itemName = String((item as Record<string, unknown>).name ?? '').trim();
    if (!Number.isInteger(itemId) || itemId <= 0 || !itemName) continue;
    if (!out.has(itemId)) out.set(itemId, itemName);
  }

  return out;
}

function parseBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function hasMaxTrackUpgrades(title: string | null, difficulty: 'heroic' | 'mythic' | null): boolean {
  const normalized = String(title ?? '').toLowerCase();
  if (difficulty === 'mythic') return /\bmyth\s*6\s*\/\s*6\b/i.test(normalized);
  if (difficulty === 'heroic') return /\bhero\s*6\s*\/\s*6\b/i.test(normalized);
  return /\b(?:hero|myth)\s*6\s*\/\s*6\b/i.test(normalized);
}

function readUpgradeAllSetting(rawFormData: Record<string, unknown> | null | undefined): boolean | null {
  if (!rawFormData) return null;

  const directKeys = [
    'upgrade_all_equipped',
    'upgradeAllEquipped',
    'upgradeAllEquippedGear',
    'upgrade_all_equipped_gear',
    'upgrade_all_gear',
    'upgradeAllGear',
    'upgrade_all_items',
    'upgradeAllItems',
    'allItemsToSameLevel',
    'all_items_to_same_level',
  ];

  for (const key of directKeys) {
    if (!(key in rawFormData)) continue;
    const parsed = parseBool(rawFormData[key]);
    if (parsed != null) return parsed;
  }

  const droptimizer = rawFormData.droptimizer;
  if (droptimizer && typeof droptimizer === 'object') {
    const dropRecord = droptimizer as Record<string, unknown>;
    const nestedKeys = [
      'upgradeEquipped',
      'upgrade_equipped',
      'upgradeAllEquipped',
      'upgrade_all_equipped',
    ];

    for (const key of nestedKeys) {
      if (!(key in dropRecord)) continue;
      const parsed = parseBool(dropRecord[key]);
      if (parsed != null) return parsed;
    }
  }

  // Fallback: scan values that might hold serialized options blobs.
  const values = Object.values(rawFormData);
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.toLowerCase();
    if (/(upgrade[^\n]*all[^\n]*equipped[^\n]*(true|false|1|0))/.test(normalized)) {
      if (/(true|1)\b/.test(normalized)) return true;
      if (/(false|0)\b/.test(normalized)) return false;
    }
  }

  return null;
}

export function validateRaidbotsReportConfig(data: RaidbotsReportData): string | null {
  if (!data.raidSlug) {
    return 'Report must target a supported raid (The Dreamrift, The Voidspire, or March on Quel\'Danas).';
  }
  if (data.difficulty !== 'heroic' && data.difficulty !== 'mythic') {
    return 'Report must target Heroic or Mythic raid difficulty.';
  }
  if (!data.config.maxTrackUpgrades) {
    return data.difficulty === 'mythic'
      ? 'Report must be configured with Upgrade up to Myth 6/6.'
      : 'Report must be configured with Upgrade up to Hero 6/6.';
  }
  if (data.config.upgradeAllEquipped !== true) {
    return 'Report must enable "Upgrade All Equipped Gear to the Same Level".';
  }
  return null;
}

export function parseRaidbotsReport(reportId: string, data: unknown): RaidbotsReportData {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid Raidbots report data: not an object');
  }

  const root = data as Record<string, unknown>;
  const sim = root.sim as Record<string, unknown> | undefined;
  const simbot = root.simbot as Record<string, unknown> | null | undefined;
  const meta = simbot?.meta as Record<string, unknown> | null | undefined;
  const rawFormData = meta?.rawFormData as Record<string, unknown> | null | undefined;
  const itemNameById = buildDroptimizerItemNameMap(rawFormData);

  // Character name + realm from SimC export text
  const simcText = String(rawFormData?.text ?? '');
  const { name: characterName, realm } = parseCharacterFromSimc(simcText);

  // Title (prefer rawFormData.title, fall back to simbot root)
  const title = String(rawFormData?.title ?? (simbot?.title ?? '') ?? '').trim() || null;

  // Raid slug + difficulty from title
  const raidSlug   = title ? parseRaidSlugFromTitle(title)   : null;
  const diffFromTitle = title ? parseDifficultyFromTitle(title) : null;
  const maxTrackUpgrades = hasMaxTrackUpgrades(title, diffFromTitle);
  const upgradeAllEquipped = readUpgradeAllSetting(rawFormData);

  // Baseline DPS
  const players = (sim?.players as unknown[] | undefined) ?? [];
  const firstPlayer = players[0] as Record<string, unknown> | undefined;
  const collectedData = firstPlayer?.collected_data as Record<string, unknown> | undefined;
  const dpsData = collectedData?.dps as Record<string, unknown> | undefined;
  const playerBaselineDps = Number(dpsData?.mean) || 0;

  const profilesets = sim?.profilesets as Record<string, unknown> | undefined;
  const results = (profilesets?.results as unknown[] | undefined) ?? [];

  // Look for an explicit "Baseline" profileset result
  let baselineDps = playerBaselineDps;
  for (const r of results) {
    const res = r as Record<string, unknown>;
    const name = String(res.name ?? '');
    if (name === 'Baseline' || name.startsWith('Baseline/')) {
      const mean = Number(res.mean);
      if (Number.isFinite(mean) && mean > 0) {
        baselineDps = mean;
      }
      break;
    }
  }

  if (baselineDps <= 0) {
    throw new Error('Could not determine baseline DPS from report');
  }

  // Parse per-item scores
  const best = new Map<number, RaidbotsItemScore>();

  for (const r of results) {
    const res = r as Record<string, unknown>;
    const name = String(res.name ?? '');
    const parts = name.split('/');

    if (parts.length < 7) continue;

    const itemId = parseInt(parts[3], 10);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;

    const mean = Number(res.mean);
    if (!Number.isFinite(mean)) continue;

    const delta = mean - baselineDps;
    const pctGain = baselineDps > 0 ? (delta / baselineDps) * 100 : null;

    const difficulty = parseDifficultyFromProfilesetName(parts[2]) ?? diffFromTitle;
    const ilvl  = parseInt(parts[4], 10);
    const slot  = parts[6] || null;

    const existing = best.get(itemId);
    if (!existing || delta > existing.deltaDps) {
      best.set(itemId, {
        itemId,
        itemLabel: itemNameById.get(itemId) ?? null,
        deltaDps: delta,
        pctGain:  pctGain != null ? Math.round(pctGain * 100) / 100 : null,
        slot:     slot || null,
        ilvl:     Number.isInteger(ilvl) && ilvl > 0 ? ilvl : null,
        difficulty,
      });
    }
  }

  return {
    reportId,
    characterName,
    realm,
    difficulty: diffFromTitle,
    raidSlug,
    title,
    baselineDps,
    scores: [...best.values()],
    config: {
      maxTrackUpgrades,
      upgradeAllEquipped,
    },
  };
}

export async function fetchRaidbotsReport(reportId: string): Promise<RaidbotsReportData> {
  const url = `https://www.raidbots.com/reports/${encodeURIComponent(reportId)}/data.json`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Raidbots returned HTTP ${resp.status} for report ${reportId}`);
  }
  const data: unknown = await resp.json();
  return parseRaidbotsReport(reportId, data);
}
