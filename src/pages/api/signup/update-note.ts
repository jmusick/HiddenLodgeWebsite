export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

function parsePositiveInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return '/signup';
  if (!value.startsWith('/')) return '/signup';
  return value;
}

function redirectWithStatus(returnTo: string, status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=${status}` },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const signupId = parsePositiveInt(formData.get('signup_id'));
  const signupNotes = (formData.get('signup_notes') as string | null)?.trim() || null;
  const returnTo = safeReturnPath(formData.get('return_to'));

  if (!signupId) {
    return redirectWithStatus(returnTo, 'error');
  }

  try {
    // Verify user owns this signup
    const signup = await env.DB.prepare(
      `SELECT user_id, raid_kind, occurrence_start_utc, ad_hoc_raid_id
       FROM raid_signups
       WHERE id = ?`
    )
      .bind(signupId)
      .first<{
        user_id: number;
        raid_kind: 'primary' | 'adhoc';
        occurrence_start_utc: number | null;
        ad_hoc_raid_id: number | null;
      }>();

    if (!signup || signup.user_id !== user.id) {
      return redirectWithStatus(returnTo, 'error');
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    if (signup.raid_kind === 'primary' && signup.occurrence_start_utc && signup.occurrence_start_utc <= nowEpoch) {
      return redirectWithStatus(returnTo, 'locked');
    }
    if (signup.raid_kind === 'adhoc' && signup.ad_hoc_raid_id) {
      const raid = await env.DB.prepare('SELECT starts_at_utc FROM ad_hoc_raids WHERE id = ?')
        .bind(signup.ad_hoc_raid_id)
        .first<{ starts_at_utc: number }>();

      if (!raid) {
        return redirectWithStatus(returnTo, 'error');
      }

      if (raid.starts_at_utc <= nowEpoch) {
        return redirectWithStatus(returnTo, 'locked');
      }
    }

    // Update the note
    await env.DB.prepare(
      'UPDATE raid_signups SET signup_notes = ?, updated_at = unixepoch() WHERE id = ?'
    )
      .bind(signupNotes, signupId)
      .run();
  } catch {
    return redirectWithStatus(returnTo, 'error');
  }

  return redirectWithStatus(returnTo, 'note-updated');
}
