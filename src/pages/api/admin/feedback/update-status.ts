export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

const VALID_STATUSES = new Set(['new', 'reviewed']);

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return '/admin/feedback';
  if (!value.startsWith('/admin/feedback')) return '/admin/feedback';
  return value;
}

function redirectWithStatus(returnTo: string, status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=${status}` },
  });
}

function parsePositiveInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const feedbackId = parsePositiveInt(formData.get('feedback_id'));
  const status = ((formData.get('status') as string | null) ?? '').trim().toLowerCase();
  const returnTo = safeReturnPath(formData.get('return_to'));

  if (!feedbackId || !VALID_STATUSES.has(status)) {
    return redirectWithStatus(returnTo, 'error');
  }

  try {
    await env.DB.prepare(
      `UPDATE guild_feedback
       SET status = ?, reviewed_at = CASE WHEN ? = 'reviewed' THEN unixepoch() ELSE NULL END
       WHERE id = ?`
    )
      .bind(status, status, feedbackId)
      .run();
  } catch {
    return redirectWithStatus(returnTo, 'error');
  }

  return redirectWithStatus(returnTo, 'ok');
}
