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

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const signupId = parsePositiveInt(formData.get('signup_id'));
  const signupNotes = (formData.get('signup_notes') as string | null)?.trim() || null;
  const returnTo = safeReturnPath(formData.get('return_to'));

  if (!signupId) {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  try {
    // Verify user owns this signup
    const signup = await env.DB.prepare(
      'SELECT user_id FROM raid_signups WHERE id = ?'
    )
      .bind(signupId)
      .first();

    if (!signup || signup.user_id !== user.id) {
      return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
    }

    // Update the note
    await env.DB.prepare(
      'UPDATE raid_signups SET signup_notes = ?, updated_at = unixepoch() WHERE id = ?'
    )
      .bind(signupNotes, signupId)
      .run();
  } catch {
    return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=error` } });
  }

  return new Response(null, { status: 302, headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=note-updated` } });
}
