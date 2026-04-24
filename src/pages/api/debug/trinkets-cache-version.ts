export const prerender = false;

import type { APIContext } from 'astro';
import {
  TRINKET_CACHE_KEY_PREFIX,
  TRINKET_CACHE_SCHEMA_VERSION,
  TRINKET_EXTENDED_RANKING_PAGES,
  TRINKET_INITIAL_RANKING_PAGES,
  TRINKET_MAX_PARSE_ROWS,
  TRINKET_MAX_PARSE_SCAN_ROWS,
} from '../../../lib/trinkets';

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  return new Response(
    JSON.stringify({
      cacheKeyPrefix: TRINKET_CACHE_KEY_PREFIX,
      cacheSchemaVersion: TRINKET_CACHE_SCHEMA_VERSION,
      maxParseRows: TRINKET_MAX_PARSE_ROWS,
      maxParseScanRows: TRINKET_MAX_PARSE_SCAN_ROWS,
      initialPages: TRINKET_INITIAL_RANKING_PAGES,
      extendedPages: TRINKET_EXTENDED_RANKING_PAGES,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }
  );
}
