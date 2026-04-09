export const prerender = false;

import type { APIContext } from 'astro';
import { refreshAttendanceCache } from '../../../../lib/attendance';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    await refreshAttendanceCache();
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/performance-review?status=sync-ok' },
    });
  } catch (error) {
    console.error('Admin attendance refresh failed', error);
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/performance-review?status=sync-error' },
    });
  }
}
