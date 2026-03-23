export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isCharacterOwner } from '../../../lib/auth';
import { getLatestSimForRaider, purgeSimHistoryForRaider } from '../../../lib/sim-api';

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const charId = parsePositiveInt((payload as Record<string, unknown> | null)?.char_id);
  if (!charId) {
    return Response.json({ error: 'char_id must be a positive integer.' }, { status: 400 });
  }

  if (!context.locals.isAdmin) {
    const ownsCharacter = await isCharacterOwner(env.DB, context.locals.user.id, charId);
    if (!ownsCharacter) {
      return Response.json(
        { error: 'Only the character owner or an officer can purge sim history for this character.' },
        { status: 403 }
      );
    }
  }

  try {
    const deleted = await purgeSimHistoryForRaider(env.DB, charId);
    const latest = await getLatestSimForRaider(env.DB, charId);

    return Response.json({
      success: true,
      char_id: charId,
      deleted,
      latest,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Failed to purge sim history.',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
