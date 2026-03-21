const DEFAULT_CACHE_TTL_SECONDS = 6 * 60 * 60;
const EMPTY_CACHE_TTL_SECONDS = 5 * 60;

interface BlizzardPlayableClassIndexResponse {
  classes?: Array<{
    id?: number;
    name?: string;
  }>;
}

interface BlizzardPlayableClassMediaResponse {
  assets?: Array<{ key?: string; value?: string }>;
}

type FetchJsonWithRetry = <T>(url: string, accessToken: string) => Promise<T | null>;

interface LoadClassIconMapOptions {
  accessToken: string;
  apiBase: string;
  staticNamespace: string;
  locale: string;
  fetchJsonWithRetry: FetchJsonWithRetry;
  requestConcurrency?: number;
  cacheTtlSeconds?: number;
}

let classIconCache:
  | {
      expiresAt: number;
      byClassName: Map<string, string>;
      cacheKey: string;
    }
  | null = null;

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function normalizeWowClassName(value: string): string {
  return value.trim().toLowerCase();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function loadBlizzardClassIconMap({
  accessToken,
  apiBase,
  staticNamespace,
  locale,
  fetchJsonWithRetry,
  requestConcurrency = 3,
  cacheTtlSeconds = DEFAULT_CACHE_TTL_SECONDS,
}: LoadClassIconMapOptions): Promise<Map<string, string>> {
  const cacheKey = `${apiBase}|${staticNamespace}|${locale}`;
  const now = nowInSeconds();
  if (classIconCache && classIconCache.expiresAt > now && classIconCache.cacheKey === cacheKey) {
    return classIconCache.byClassName;
  }

  const indexUrl = `${apiBase}/data/wow/playable-class/index?namespace=${staticNamespace}&locale=${locale}`;
  const playableClassIndex = await fetchJsonWithRetry<BlizzardPlayableClassIndexResponse>(indexUrl, accessToken);
  const classes = playableClassIndex?.classes ?? [];

  if (classes.length === 0) {
    classIconCache = {
      expiresAt: now + EMPTY_CACHE_TTL_SECONDS,
      byClassName: new Map<string, string>(),
      cacheKey,
    };
    return classIconCache.byClassName;
  }

  const mediaRows = await mapWithConcurrency(classes, requestConcurrency, async (entry) => {
    const classId = Number(entry.id ?? 0);
    const className = (entry.name ?? '').trim();
    if (!classId || !className) {
      return { className, iconUrl: null as string | null };
    }

    const mediaUrl = `${apiBase}/data/wow/media/playable-class/${classId}?namespace=${staticNamespace}&locale=${locale}`;
    const media = await fetchJsonWithRetry<BlizzardPlayableClassMediaResponse>(mediaUrl, accessToken);
    const iconAsset = media?.assets?.find((asset) => (asset.key ?? '').toLowerCase() === 'icon');
    const iconUrl = iconAsset?.value ?? null;
    return {
      className,
      iconUrl,
    };
  });

  const byClassName = new Map<string, string>();
  for (const row of mediaRows) {
    if (!row.className || !row.iconUrl) continue;
    byClassName.set(normalizeWowClassName(row.className), row.iconUrl);
  }

  classIconCache = {
    expiresAt: now + cacheTtlSeconds,
    byClassName,
    cacheKey,
  };

  return byClassName;
}
