export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedSimRunnerRequest } from '../../../../lib/sim-auth';
import { upsertSimRunLifecycle, validateLifecycleInput } from '../../../../lib/sim-api';

export async function POST(context: APIContext): Promise<Response> {
  if (!isAuthorizedSimRunnerRequest(context.request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { value, errors } = validateLifecycleInput(payload);
  if (!value) {
    return Response.json({ error: 'Invalid payload', details: errors }, { status: 400 });
  }

  const payloadRecord = payload as Record<string, unknown>;
  const successful = payloadRecord.successful;
  const status =
    value.status === 'failed' || successful === false
      ? 'failed'
      : 'finished';
  const result = await upsertSimRunLifecycle(env.DB, {
    ...value,
    status,
  }, status);

  return Response.json(result);
}
