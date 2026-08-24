export const prerender = false;

import type { APIContext } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { getGearSlotHistory } from '../../../../lib/raiders';

function parseCharId(context: APIContext): number {
  return Number(context.params.charId);
}

export async function GET(context: APIContext): Promise<Response> {
  const charId = parseCharId(context);
  const slotKey = context.url.searchParams.get('slot');

  if (!Number.isFinite(charId) || charId <= 0 || !slotKey) {
    return Response.json({ error: 'Invalid character ID or slot' }, { status: 400 });
  }

  const db = (env as any).DB as D1Database;

  try {
    const history = await getGearSlotHistory(charId, slotKey, db);
    return Response.json({ data: history });
  } catch {
    return Response.json({ data: [] }, { status: 200 });
  }
}
