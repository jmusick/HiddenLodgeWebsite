export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';

interface Row {
  character: string;
  realm: string;
  main_character: string | null;
  nickname: string | null;
}

function trim(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function preferredNote(character: string, mainCharacter: string | null, nickname: string | null): string {
  const nick = trim(nickname);
  if (nick !== '') {
    return nick;
  }

  const main = trim(mainCharacter);
  if (main === '') {
    return '';
  }

  // Keep main characters clean by leaving note empty when main == character.
  if (main.toLowerCase() === trim(character).toLowerCase()) {
    return '';
  }

  return main;
}

export async function GET(context: APIContext): Promise<Response> {
  if (!isAuthorizedDesktopRequest(context.request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await env.DB.prepare(
    `SELECT
      c.name AS character,
      c.realm AS realm,
      main_c.name AS main_character,
      u.nickname AS nickname
    FROM characters c
    JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN characters main_c ON main_c.user_id = c.user_id AND main_c.is_main = 1
    ORDER BY c.name ASC`
  ).all<Row>();

  const entries = (result.results ?? []).map((row) => {
    const character = trim(row.character);
    const realm = trim(row.realm);
    const main = trim(row.main_character);
    const nickname = trim(row.nickname);

    return {
      character,
      realm,
      main,
      nickname,
      preferredNote: preferredNote(character, main, nickname),
    };
  });

  return Response.json(entries);
}
