// Public /links page data source. The curated WoW toolbox lives in Tagstash
// (tagsta.sh) under the guild owner's profile rather than in D1 — bookmarks are
// added/retagged there and this site just renders whatever carries the tag.
const TAGSTASH_USER = 'JD';
const TAGSTASH_ORIGIN = 'https://tagsta.sh';
const CACHE_TTL_SECONDS = 600;

export interface Bookmark {
	id: number;
	title: string;
	url: string;
	description: string | null;
	faviconUrl: string | null;
	/** Tag names left after the fetch tag and NOISE_TAGS are dropped, sorted. */
	categories: string[];
}

interface TagstashTag {
	id: number;
	name: string;
}

interface TagstashBookmark {
	id: number;
	title: string;
	url: string;
	description: string | null;
	favicon_url: string | null;
	tags?: TagstashTag[];
}

interface TagstashResponse {
	bookmarks?: TagstashBookmark[];
}

// Tags that every (or nearly every) WoW bookmark carries, so they'd make useless
// filter chips. The fetch tag itself is excluded automatically.
const NOISE_TAGS = ['gaming', 'mmorpg', 'arpg'];

async function fetchJson(url: string): Promise<TagstashResponse> {
	// Cloudflare's edge cache — the API is public and slow-moving, so a shared
	// 10-minute entry keeps SSR renders from hitting tagsta.sh on every request.
	const cache = (caches as CacheStorage & { readonly default?: Cache }).default;
	const cacheKey = new Request(url);

	let res = cache ? await cache.match(cacheKey) : undefined;
	if (!res) {
		res = await fetch(url, { headers: { Accept: 'application/json' } });
		if (res.ok && cache) {
			const cacheable = new Response(res.body, res);
			cacheable.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
			await cache.put(cacheKey, cacheable.clone());
			res = cacheable;
		}
	}

	if (!res.ok) {
		throw new Error(`tagsta.sh responded with ${res.status}`);
	}

	return (await res.json()) as TagstashResponse;
}

/**
 * Bookmarks carrying `tag`, sorted by title. Throws if tagsta.sh is unreachable
 * or errors — callers decide what to show instead.
 */
export async function fetchBookmarksByTag(tag: string): Promise<Bookmark[]> {
	const url = `${TAGSTASH_ORIGIN}/api/profiles/${encodeURIComponent(TAGSTASH_USER)}?tag=${encodeURIComponent(tag)}`;
	const data = await fetchJson(url);

	const excluded = new Set([tag, ...NOISE_TAGS].map((t) => t.toLowerCase()));

	return (data.bookmarks ?? [])
		.map((b) => ({
			id: b.id,
			title: b.title,
			url: b.url,
			description: b.description,
			faviconUrl: b.favicon_url,
			categories: (b.tags ?? [])
				.map((t) => t.name)
				.filter((name) => !excluded.has(name.toLowerCase()))
				.sort((a, b) => a.localeCompare(b)),
		}))
		.sort((a, b) => a.title.localeCompare(b.title));
}

/** Category name -> number of bookmarks carrying it, sorted by name. */
export function countCategories(bookmarks: Bookmark[]): { name: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const b of bookmarks) {
		for (const name of b.categories) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export const TAGSTASH_PROFILE_URL = `${TAGSTASH_ORIGIN}/${TAGSTASH_USER}`;
