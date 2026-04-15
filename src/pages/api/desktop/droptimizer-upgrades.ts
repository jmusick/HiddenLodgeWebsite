export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';
import { getDesktopDroptimizerUpgrades } from '../../../lib/sim-api';

export async function GET(context: APIContext): Promise<Response> {
  if (!isAuthorizedDesktopRequest(context.request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const entries = await getDesktopDroptimizerUpgrades(env.DB);

  return Response.json(
    entries.map((entry) => ({
      blizzardCharId: entry.blizzardCharId,
      character: entry.character,
      realm: entry.realm,
      itemId: entry.itemId,
      deltaDps: entry.deltaDps,
      pctGain: entry.pctGain,
      difficulty: entry.difficulty,
      updatedAt: entry.updatedAt,
      source: entry.source,
      sourceReportId: entry.sourceReportId,
      sourceRaid: entry.sourceRaid,
      sourceDifficulty: entry.sourceDifficulty,
    })),
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
