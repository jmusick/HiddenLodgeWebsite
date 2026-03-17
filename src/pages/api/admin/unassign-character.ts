export const prerender = false;

import type { APIContext } from 'astro';

// Removed: mains/alts are now managed via user authentication only.
export async function POST(_context: APIContext): Promise<Response> {
return new Response('Gone', { status: 410 });
}
