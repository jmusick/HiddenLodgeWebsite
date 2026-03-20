export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getDefaultRaidProgressTierId, isValidRaidProgressTierId } from '../../../../data/raidProgressTargets';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const formData = await context.request.formData();
    const requestedTarget = (formData.get('raid_progress_target') as string | null)?.trim() ?? '';
    const target = requestedTarget || getDefaultRaidProgressTierId();

    if (!isValidRaidProgressTierId(target)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/settings?status=raid-target-error' },
      });
    }

    await env.DB
      .prepare(
        `INSERT INTO site_settings (key, value, updated_at)
         VALUES ('raid_progress_target', ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .bind(target)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/settings?status=raid-target-updated' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/settings?status=raid-target-error' },
    });
  }
}
