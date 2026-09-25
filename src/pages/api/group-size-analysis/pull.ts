import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';
import { getGroupSizePull } from '../../../lib/group-size-pulls';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  if (!context.locals.isGuildMember) return new Response('Forbidden', { status: 403 });
  if (!FEATURE_FLAGS.tools || !FEATURE_FLAGS.groupSizeAnalysis) return new Response('Not found', { status: 404 });
  const report = context.url.searchParams.get('report') ?? '';
  const fight = Number(context.url.searchParams.get('fight'));
  if (!/^[A-Za-z0-9]{16}$/.test(report) || !Number.isInteger(fight) || fight <= 0) {
    return new Response('Invalid pull', { status: 400 });
  }
  try {
    const pull = await getGroupSizePull(env.DB, report, fight);
    if (!pull) return new Response('Pull not found', { status: 404 });
    return Response.json(pull, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[group-size-analysis] pull load failed', error instanceof Error ? error.message : String(error));
    return new Response('Could not load this pull from Warcraft Logs. Try again later.', { status: 503 });
  }
};
