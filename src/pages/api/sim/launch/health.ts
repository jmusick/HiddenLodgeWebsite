export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

function readBaseUrl(): string | null {
  const base = env.WOWSIM_APP_BASE_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function readTriggerPath(): string {
  const raw = env.WOWSIM_APP_TRIGGER_PATH?.trim() || '/api/jobs/start';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
  };

  const apiKey = env.WOWSIM_APP_API_KEY?.trim();
  if (apiKey) headers['X-WoWSim-Key'] = apiKey;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const baseUrl = readBaseUrl();
  if (!baseUrl) {
    return Response.json(
      {
        online: false,
        message: 'WOWSIM_APP_BASE_URL is not configured.',
      },
      { status: 200 }
    );
  }

  const healthUrl = `${baseUrl}${readTriggerPath()}`;
  try {
    const response = await fetchWithTimeout(healthUrl, {
      method: 'OPTIONS',
      headers: buildHeaders(),
    }, 2500);

    return Response.json({
      online: response.ok || response.status === 405 || response.status === 401,
      status: response.status,
      message: response.ok || response.status === 405 || response.status === 401
        ? 'Connected to LodgeSim launch endpoint.'
        : `LodgeSim responded with HTTP ${response.status}.`,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Timed out while connecting to LodgeSim app.'
        : error instanceof Error
          ? error.message
          : String(error);

    return Response.json({
      online: false,
      message,
    });
  }
}
