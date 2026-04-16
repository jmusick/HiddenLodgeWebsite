export const prerender = false;

import type { APIContext } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { getRaiderRaidbotsTableData } from '../../../../lib/sim-api';

function parseCharId(context: APIContext): number {
  return Number(context.params.charId);
}

export async function GET(context: APIContext): Promise<Response> {
  const charId = parseCharId(context);
  if (!Number.isFinite(charId) || charId <= 0) {
    return Response.json({ error: 'Invalid character ID' }, { status: 400 });
  }

  const db = (env as any).DB as D1Database;

  try {
    const tableData = await getRaiderRaidbotsTableData(db, charId);
    return Response.json({ data: tableData });
  } catch {
    return Response.json({ data: [] }, { status: 200 });
  }
}
