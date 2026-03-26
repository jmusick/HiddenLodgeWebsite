export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const VALID_CLASSES = new Set([
  'Death Knight', 'Demon Hunter', 'Druid', 'Evoker', 'Hunter',
  'Mage', 'Monk', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior',
]);

const VALID_ROLES = new Set(['Tank', 'Healer', 'Ranged DPS', 'Melee DPS']);
const VALID_PRIORITIES = new Set(['low', 'mid', 'high']);

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const formData = await context.request.formData();
    const cls = (formData.get('class') as string | null)?.trim() ?? '';
    const role = (formData.get('role') as string | null)?.trim() ?? '';
    const priority = (formData.get('priority') as string | null)?.trim() ?? 'mid';
    const sortOrder = parseInt((formData.get('sort_order') as string | null) ?? '0', 10);

    if (!VALID_CLASSES.has(cls) || !VALID_ROLES.has(role) || !VALID_PRIORITIES.has(priority)) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/raiding?status=error' },
      });
    }

    await env.DB
      .prepare(`INSERT INTO recruitment_needs (class, role, priority, sort_order) VALUES (?, ?, ?, ?)`)
      .bind(cls, role, priority, isNaN(sortOrder) ? 0 : sortOrder)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=need-created' },
    });
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/raiding?status=error' },
    });
  }
}
