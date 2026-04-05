export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return '/feedback';
  if (!value.startsWith('/')) return '/feedback';
  return value;
}

function redirectWithStatus(returnTo: string, status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${returnTo}${returnTo.includes('?') ? '&' : '?'}status=${status}` },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user) return new Response('Unauthorized', { status: 401 });
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const returnTo = safeReturnPath(formData.get('return_to'));

  const rawName = (formData.get('display_name') as string | null) ?? '';
  const rawMessage = (formData.get('message') as string | null) ?? '';

  const displayName = rawName.trim() || null;
  const message = rawMessage.trim();

  if (message.length < 5 || message.length > 2000 || (displayName && displayName.length > 80)) {
    return redirectWithStatus(returnTo, 'invalid');
  }

  try {
    await env.DB.prepare(
      `INSERT INTO guild_feedback (display_name, message, submitted_at)
       VALUES (?, ?, unixepoch())`
    )
      .bind(displayName, message)
      .run();
  } catch {
    return redirectWithStatus(returnTo, 'error');
  }

  return redirectWithStatus(returnTo, 'ok');
}
