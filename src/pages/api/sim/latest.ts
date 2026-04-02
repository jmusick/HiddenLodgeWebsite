export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isCharacterOwner } from '../../../lib/auth';
import { getLatestSimByTeam, getLatestSimForRaider, getLatestSimsForRaiderByDifficulty, purgeSimHistoryForRaider } from '../../../lib/sim-api';

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parsePositiveIntUnknown(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(context.request.url);
  const charId = parsePositiveInt(url.searchParams.get('char_id'));
  const teamId = parsePositiveInt(url.searchParams.get('team_id'));
  const difficulty = url.searchParams.get('difficulty');
  const groupBy = (url.searchParams.get('group_by') ?? '').trim().toLowerCase();

  if (charId) {
    if (groupBy === 'difficulty') {
      const data = await getLatestSimsForRaiderByDifficulty(env.DB, charId);
      return Response.json({ data });
    }
    const data = await getLatestSimForRaider(env.DB, charId);
    return Response.json({ data });
  }

  if (teamId) {
    const data = await getLatestSimByTeam(env.DB, teamId, difficulty ?? undefined);
    return Response.json({ data });
  }

  return Response.json(
    { error: 'Provide either char_id or team_id as a positive integer query parameter.' },
    { status: 400 }
  );
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

  const charId = parsePositiveIntUnknown((payload as Record<string, unknown> | null)?.char_id);
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
    const latestByDifficulty = await getLatestSimsForRaiderByDifficulty(env.DB, charId);
    return Response.json({
      success: true,
      char_id: charId,
      deleted,
      data: latest,
      data_by_difficulty: latestByDifficulty,
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
