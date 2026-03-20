export const prerender = false;

import type { APIContext } from 'astro';
import { refreshRaidersCache } from '../../../../lib/raiders';
import { refreshRosterCache } from '../../../../lib/roster-cache';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    await Promise.all([
      refreshRosterCache(),
      refreshRaidersCache(),
    ]);

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/settings?status=refresh-ok' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/settings?status=refresh-error' },
    });
  }
}