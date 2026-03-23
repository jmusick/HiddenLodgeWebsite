export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedSimRunnerRequest } from '../../../../lib/sim-auth';
import { getPassiveSimTasks } from '../../../../lib/sim-api';

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function GET(context: APIContext): Promise<Response> {
  if (!isAuthorizedSimRunnerRequest(context.request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(context.request.url);
  const maxTasks = parsePositiveInt(url.searchParams.get('max_tasks'), 20);
  const maxAgeSeconds = parsePositiveInt(url.searchParams.get('max_age_seconds'), 24 * 60 * 60);

  const payload = await getPassiveSimTasks(env.DB, {
    maxTasks,
    maxAgeSeconds,
  });

  return Response.json(payload);
}
