export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeAssignedRole } from '../../../../lib/raid-teams';

const REDIRECT_BASE = '/admin/raid-signups';

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return REDIRECT_BASE;
  if (!value.startsWith('/')) return REDIRECT_BASE;
  return value;
}

function statusRedirect(status: string, returnTo: string): Response {
  const sep = returnTo.includes('?') ? '&' : '?';
  return new Response(null, { status: 302, headers: { Location: `${returnTo}${sep}status=${status}` } });
}

export async function GET(): Promise<Response> {
  return statusRedirect('error', REDIRECT_BASE);
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.isAdmin) return new Response('Forbidden', { status: 403 });

  const formData = await context.request.formData();
  const returnTo = safeReturnPath(formData.get('return_to'));
  const signupId = Number.parseInt((formData.get('signup_id') as string | null) ?? '', 10);
  const signupRole = normalizeAssignedRole((formData.get('signup_role') as string | null) ?? null);

  if (!Number.isInteger(signupId) || signupId <= 0 || !signupRole) {
    return statusRedirect('error', returnTo);
  }

  const result = await env.DB.prepare(
    `UPDATE raid_signups
     SET signup_role = ?, updated_at = unixepoch()
     WHERE id = ?`
  )
    .bind(signupRole, signupId)
    .run();

  const changes = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changes < 1) {
    return statusRedirect('error', returnTo);
  }

  return statusRedirect('signup-role-updated', returnTo);
}
