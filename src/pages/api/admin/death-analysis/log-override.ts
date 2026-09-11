export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { canManageLogMatching, isValidNightKey, setNightOverride } from '../../../../lib/death-analysis';
import { FEATURE_FLAGS } from '../../../../lib/feature-flags';

function redirect(status: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/admin/log-matching?status=${status}` } });
}

function parseReportCode(rawValue: FormDataEntryValue | null): string | null {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) return null;
  const candidate = raw.match(/warcraftlogs\.com\/reports\/([A-Za-z0-9]+)/i)?.[1] ?? raw;
  return /^[A-Za-z0-9]+$/.test(candidate) ? candidate : null;
}

export async function POST(context: APIContext): Promise<Response> {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!FEATURE_FLAGS.deathAnalysis) return new Response('Not found', { status: 404 });
  if (!(await canManageLogMatching(env.DB, user, context.locals.isAdmin))) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await context.request.formData();
  const nightKey = String(formData.get('night_key') ?? '').trim();
  if (!isValidNightKey(nightKey)) return redirect('error');

  const reportCode = parseReportCode(formData.get('report_code_manual')) ?? parseReportCode(formData.get('report_code'));

  try {
    await setNightOverride(env.DB, nightKey, reportCode, user.id);
    return redirect(reportCode ? 'override-saved' : 'override-cleared');
  } catch (error) {
    console.error('Death analysis log override failed', error);
    return redirect('error');
  }
}
