export const prerender = false;

import type { APIContext } from 'astro';

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  return new Response(
    JSON.stringify({
      cacheKeyPrefix: 'trinket_tier_data_v8',
      cacheSchemaVersion: 2,
      maxParseRows: 100,
      maxParseScanRows: 300,
      initialPages: 3,
      extendedPages: 8,
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
