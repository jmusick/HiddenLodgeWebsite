export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedSimRunnerRequest } from '../../../lib/sim-auth';
import { getSimTargets } from '../../../lib/sim-api';

export async function GET(context: APIContext): Promise<Response> {
  if (!isAuthorizedSimRunnerRequest(context.request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const payload = await getSimTargets(env.DB);
  return Response.json(payload);
}
