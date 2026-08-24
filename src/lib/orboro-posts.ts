// /articles data source. Posts are written and tagged on Orboro.net rather than
// stored in this repo — this site just renders whatever carries the given category.
const ORBORO_ORIGIN = 'https://orboro.net';
const CACHE_TTL_SECONDS = 600;

export interface OrboroPost {
	title: string;
	slug: string;
	url: string;
	excerpt: string;
	publishedAt: string | null;
	featuredImageUrl: string | null;
}

interface OrboroPostsResponse {
	category?: { name: string; slug: string };
	posts?: OrboroPost[];
}

async function fetchJson(url: string): Promise<OrboroPostsResponse> {
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
		throw new Error(`orboro.net responded with ${res.status}`);
	}

	return (await res.json()) as OrboroPostsResponse;
}

/**
 * Published Orboro posts tagged with `categorySlug`, newest first. Throws if
 * orboro.net is unreachable or errors — callers decide what to show instead.
 */
export async function fetchOrboroPostsByCategory(categorySlug: string): Promise<OrboroPost[]> {
	const url = `${ORBORO_ORIGIN}/api/posts/by-category/${encodeURIComponent(categorySlug)}`;
	const data = await fetchJson(url);
	return data.posts ?? [];
}
