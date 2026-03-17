export const prerender = false;

import type { APIContext } from 'astro';

// Removed: Replaced by /api/admin/update-nickname.
export async function POST(_context: APIContext): Promise<Response> {
return new Response('Gone', { status: 410 });
}
